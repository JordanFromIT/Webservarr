# WebServarr - Setup Guide

## Prerequisites

- Docker and Docker Compose (v2+)
- A server or machine to run the containers

## Quick Start

```bash
# Clone the repository
git clone https://github.com/webservarr/webservarr.git
cd webservarr

# Start the containers
docker compose up -d

# Verify
docker compose ps
curl http://localhost:8000/health
```

Open `http://localhost:8000` in your browser. You should see the login page.

## First-Time Setup

1. **Log in** with the default admin credentials: `admin` / `admin123`
2. **Change the default password** -- navigate to Settings > System
3. **Configure integrations** -- navigate to Settings > Integrations

### Integrations

Each integration has a **Test Connection** button to verify your credentials before saving.

**Plex** (recommended first):
- Enter your Plex server URL (e.g., `http://10.0.0.5:32400`)
- Enter your Plex API token ([how to find your token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/))
- Click "Test Connection", then "Save"
- Once configured, the "Sign in with Plex" button appears on the login page

**Uptime Kuma:**
- Enter your Uptime Kuma URL (e.g., `http://10.0.0.5:3001`)
- Enter the status page slug (the part after `/status/` in your status page URL)
- Click "Test Connection", then "Save"

**Overseerr:**
- Enter your Overseerr URL (e.g., `http://10.0.0.5:5055`)
- Enter your Overseerr API key (found in Overseerr Settings > General)
- Click "Test Connection", then "Save"

**Radarr:**
- Enter your Radarr URL (e.g., `http://10.0.0.5:7878`)
- Enter your Radarr API key (found in Radarr Settings > General)
- Click "Test Connection", then "Save"

**Sonarr:**
- Enter your Sonarr URL (e.g., `http://10.0.0.5:8989`)
- Enter your Sonarr API key (found in Sonarr Settings > General)
- Click "Test Connection", then "Save"

**Netdata:**
- Enter your Netdata URL (e.g., `http://10.0.0.5:19999`)
- Click "Test Connection", then "Save"

## Configuration

All configuration is done through the **Settings UI** after logging in. No manual file editing is required for normal operation.

### Environment Variables (Advanced)

For most users, the Settings UI is sufficient. Advanced users can override defaults via environment variables in a `.env` file or in `docker-compose.yml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_DOMAIN` | `localhost` | Your domain (e.g., `dashboard.example.com`) |
| `APP_SCHEME` | `https` | URL scheme (`http` for local/development) |
| `REDIS_URL` | `redis://redis:6379/0` | Redis connection string |
| `CORS_ORIGINS` | `""` | Additional CORS origins (comma-separated) |
| `CSP_FRAME_SRC` | `""` | Additional CSP frame-src origins |
| `CSP_CONNECT_SRC` | `""` | Additional CSP connect-src origins |

A secret key for session signing is auto-generated on first startup and stored in the database. You do not need to set `APP_SECRET_KEY` unless you want to override it.

## Updating

```bash
# Pull the latest code
git pull

# Rebuild and restart
docker compose up -d --build
```

Your data (SQLite database) and uploads (logos) are stored in mounted volumes and persist across rebuilds.

## Backup

Back up these directories regularly:

- `data/` -- SQLite database (users, news, settings, notifications)
- `uploads/` -- Uploaded assets (logos)
- `.env` -- Environment overrides (if you use any)

```bash
# Example backup
tar czf webservarr-backup-$(date +%Y%m%d).tar.gz data/ uploads/ .env
```

## Advanced: Authentik OIDC Setup

If you want to use Authentik as an OIDC identity provider for Plex login (useful if you already run Authentik for SSO across multiple services):

### 1. Start the Authentik containers

```bash
# Create environment variables for Authentik
cat >> .env << 'EOF'
AUTHENTIK_SECRET_KEY=your-authentik-secret-here
POSTGRES_PASSWORD=your-postgres-password-here
EOF

# Start with the Authentik overlay
docker compose -f docker-compose.yml -f docker-compose.authentik.yml up -d
```

### 2. Configure Authentik

1. Open Authentik at `http://localhost:9000` and complete initial setup
2. Add a **Plex source** in Authentik (Sources > Create > Plex)
3. Create an **OAuth2 provider** (Providers > Create > OAuth2/OIDC)
   - Set the redirect URI to `https://your-domain.com/auth/callback`
   - Note the Client ID and Client Secret
4. Create an **Application** (Applications > Create) linked to the provider

### 3. Configure WebServarr

1. In WebServarr, go to Settings > Integrations > Authentik
2. Enter:
   - Authentik URL (e.g., `https://auth.example.com`)
   - Client ID (from the OAuth2 provider)
   - Client Secret (from the OAuth2 provider)
   - App Slug (the slug of the Authentik application)
3. Save

The "Sign in with Plex (via Authentik)" button will appear on the login page.

## Advanced: Reverse Proxy

WebServarr runs on port 8000 by default. To expose it on a custom domain with HTTPS, use a reverse proxy.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name dashboard.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Caddy

```
dashboard.example.com {
    reverse_proxy localhost:8000
}
```

### Cloudflare Tunnel

```bash
cloudflared tunnel route dns <tunnel-name> dashboard.example.com
```

In your Cloudflare Tunnel config, point the hostname to `http://localhost:8000`.

When using a reverse proxy, set the `APP_DOMAIN` environment variable to your domain:

```bash
# In .env or docker-compose.yml
APP_DOMAIN=dashboard.example.com
APP_SCHEME=https
```

## Troubleshooting

### Container will not start

```bash
docker compose logs webservarr
docker compose down
docker compose up -d
```

### Database issues

```bash
# Check if database file exists
ls -la data/webservarr.db

# Query the database from inside the container
docker compose exec webservarr sqlite3 /app/data/webservarr.db ".tables"
```

### Session issues (cannot log in or stay logged in)

```bash
# Check Redis is running
docker compose ps redis

# Verify Redis connectivity from the app container
docker compose exec webservarr python -c "import redis; r = redis.from_url('redis://redis:6379/0'); print(r.ping())"
```

### Plex OAuth not working

- Verify Plex integration is configured in Settings > Integrations > Plex
- Check that the Plex URL is reachable from the WebServarr container
- Check logs: `docker compose logs webservarr | grep -i plex`

### Reset everything (destroys all data)

```bash
docker compose down
rm -f data/webservarr.db
docker volume rm webservarr_redis_data 2>/dev/null
docker compose up -d
```

This recreates the database with a fresh admin user and clears all sessions.

## Viewing Logs

```bash
# WebServarr logs
docker compose logs -f webservarr

# All container logs
docker compose logs

# Redis logs
docker compose logs redis
```
