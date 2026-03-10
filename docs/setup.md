# WebServarr - Setup Guide

## Prerequisites

- Docker and Docker Compose (v2+)
- A server or machine to run the containers

## Quick Start

```bash
# Clone the repository
git clone https://github.com/JordanFromIT/webservarr.git
cd webservarr

# Start the containers
docker compose up -d

# Verify
docker compose ps
curl http://localhost:7979/health
```

Open `http://localhost:7979` in your browser.

## First-Time Setup

On first launch, the **setup wizard** will guide you through three steps:

1. **Create Admin Account** -- choose a username and password (minimum 8 characters)
2. **Security Key** -- a secret key is auto-generated for session signing. Save it somewhere safe for backup/migration purposes
3. **Connect Plex (Optional)** -- enter your Plex server URL and API token to enable Plex integration and OAuth login. You can skip this and configure it later in Settings

After completing the wizard, you'll be redirected to the login page. Log in with the credentials you just created, then head to **Settings > Integrations** to connect your other services.

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
| `APP_DOMAIN` | `localhost` | Your domain — used for CSP headers (e.g., `dashboard.example.com`) |
| `APP_SCHEME` | `https` | URL scheme — used for CSP headers (`http` for local/development) |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection string (embedded; override to use external Redis) |
| `CORS_ORIGINS` | `""` | Additional CORS origins (comma-separated) |
| `CSP_FRAME_SRC` | `""` | Additional CSP frame-src origins |
| `CSP_CONNECT_SRC` | `""` | Additional CSP connect-src origins |

The secret key for session signing is set during the setup wizard and stored in the database. Changing it (e.g., via the `APP_SECRET_KEY` environment variable) will invalidate all active sessions.

## Updating

### Docker Compose

```bash
docker compose pull
docker compose up -d
```

### docker run

```bash
docker pull ghcr.io/jordanfromit/webservarr:latest
docker stop webservarr
docker rm webservarr
docker run -d \
  --name webservarr \
  --restart unless-stopped \
  -p 7979:7979 \
  -v ./data:/app/data \
  -v ./uploads:/app/app/static/uploads \
  ghcr.io/jordanfromit/webservarr:latest
```

### Automatic updates with Watchtower (optional)

[Watchtower](https://containrrr.dev/watchtower/) watches Docker Hub for new image versions and automatically recreates your containers when a new `:latest` is published.

```bash
docker run -d \
  --name watchtower \
  -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower \
  webservarr
```

This restarts the `webservarr` container when a new image is available. Your data volumes persist across restarts.

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

Authentik provides Plex login *through* a centralized identity provider. This is useful if you already run Authentik for SSO across multiple services, or want centralized session management. If you just want users to sign in with Plex, use **direct Plex OAuth** instead — it requires no Authentik and is configured entirely in Settings > Integrations > Plex.

See the full **[Authentik Setup Guide](authentik.md)** for step-by-step instructions covering:

- Deploying Authentik alongside WebServarr (Docker Compose overlay)
- Connecting to an existing Authentik instance
- Creating the Plex source, custom login flow, and OAuth2 provider
- Custom property mapping for Plex token passthrough
- Verification, troubleshooting, and removal

## Advanced: Reverse Proxy

WebServarr runs on port 7979 by default. To expose it on a custom domain with HTTPS, use a reverse proxy.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name dashboard.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:7979;
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
    reverse_proxy localhost:7979
}
```

### Cloudflare Tunnel

```bash
cloudflared tunnel route dns <tunnel-name> dashboard.example.com
```

In your Cloudflare Tunnel config, point the hostname to `http://localhost:7979`.

When using a reverse proxy, set `APP_DOMAIN` and `APP_SCHEME` in your `.env` file. Auth callback URLs and cookie domains are derived from the incoming HTTP request (so login works without these set), but `APP_DOMAIN` is used for Content Security Policy headers:

```bash
# In .env or docker-compose.yml
APP_DOMAIN=dashboard.example.com
APP_SCHEME=https
```

## Security Considerations

### Admin Account

The admin account is created during the setup wizard with your chosen credentials. To change your password or username later, go to **Settings > System > Admin Account** (only visible for simple-auth users).

To disable simple auth once Plex OAuth or Authentik OIDC is configured, set `features.show_simple_auth` to `false` in Settings > System.

### Rate Limiting

All endpoints are rate-limited to prevent abuse:

| Endpoint Type | Limit |
|---|---|
| Login endpoints | 5 requests/minute per IP |
| File uploads | 10 requests/minute per IP |
| Write operations (POST/PUT/DELETE) | 30 requests/minute per IP |
| Public endpoints (branding, status) | 60 requests/minute per IP |
| Read operations (GET) | 120 requests/minute per IP |

Rate limits are enforced per client IP. When behind a reverse proxy (Cloudflare, nginx), the `CF-Connecting-IP` or `X-Forwarded-For` header is used. Exceeded limits return HTTP 429.

### Session Security

- Sessions stored in Redis with configurable expiry (default: 7 days)
- Cookies set with `HttpOnly` (no JS access), `Secure` (HTTPS-only in production), `SameSite=Lax`
- Session IDs generated with `secrets.token_urlsafe(32)` (256-bit entropy)

### Content Security

- All user-submitted HTML (news posts) sanitized with bleach using a strict tag allowlist
- Ticket text content stripped of all HTML tags
- Content Security Policy (CSP) header restricts script/style/image sources
- `X-Content-Type-Options: nosniff` prevents MIME type sniffing
- `X-Frame-Options: SAMEORIGIN` prevents clickjacking

### File Uploads

- Allowed types: PNG, JPEG, WebP (tickets); PNG, JPEG, GIF, SVG, WebP (logos)
- Maximum size: 2MB per file
- Filenames generated with UUID (no user-controlled filenames on disk)
- Magic number verification ensures file content matches declared type
- Ticket images served through authenticated endpoint (not public static files)

### Recommended Reverse Proxy Hardening

If running behind Cloudflare or nginx, consider:

- **HSTS**: Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` at the proxy level
- **Cloudflare Bot Protection**: Enable Bot Fight Mode or add Turnstile to the login page
- **Additional rate limiting**: Layer Cloudflare rate limiting rules on top of app-level limits
- **IP allowlisting**: Restrict direct access to the origin server (only allow Cloudflare IPs)

### Dependency Management

Dependencies are pinned using `pip-compile` (from `pip-tools`). To update:

```bash
pip install pip-tools
pip-compile requirements.in --output-file=requirements.txt --upgrade
docker compose up -d --build webservarr
```

GitHub Dependabot is configured to open weekly PRs for outdated or vulnerable packages.

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
# Check that Redis is running inside the container
docker compose exec webservarr redis-cli -h 127.0.0.1 ping

# Check supervisord process status
docker compose exec webservarr supervisorctl status
```

### Plex OAuth not working

- Verify Plex integration is configured in Settings > Integrations > Plex
- Check that the Plex URL is reachable from the WebServarr container
- Check logs: `docker compose logs webservarr | grep -i plex`

### Reset everything (destroys all data)

```bash
docker compose down
rm -f data/webservarr.db
docker compose up -d
```

This recreates the database and triggers the setup wizard on next visit.

## Viewing Logs

```bash
# WebServarr logs (includes both uvicorn and Redis output)
docker compose logs -f webservarr
```
