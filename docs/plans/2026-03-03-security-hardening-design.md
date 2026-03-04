# Phase 10: Security Hardening — Design

**Date:** 2026-03-03
**Approach:** Middleware-First (slowapi + manual magic bytes + pip-compile)

---

## 1. Rate Limiting

**Library:** `slowapi` (wraps `limits`, Redis backend)

**Key function:** Client IP from `X-Forwarded-For` (Cloudflare/reverse proxy) with fallback to `request.client.host`.

**Rate limit tiers:**

| Endpoint Group | Limit | Rationale |
|---|---|---|
| Login (`/auth/simple-login`, `/auth/plex-start`, `/auth/login`) | 5/min per IP | Bruteforce protection |
| File uploads (`/api/admin/upload-logo`, `/api/tickets/*/attachments`) | 10/min per IP | Disk abuse prevention |
| Write APIs (POST/PUT/DELETE on tickets, news, settings, notifications) | 30/min per IP | General abuse prevention |
| Read APIs (GET endpoints) | 120/min per IP | Generous but bounded |
| Public endpoints (`/api/branding`, `/api/status/*`, `/health`) | 60/min per IP | No auth required, moderate limit |

**Response on limit exceeded:** 429 with JSON body. Rate limit headers returned: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

---

## 2. Authenticated Upload Serving

**Problem:** Ticket images served as static files at `/static/uploads/tickets/` with no auth check.

**Design:**
- Remove `/static/uploads/tickets/` from static file mounting
- New endpoint: `GET /api/uploads/tickets/{filename}` in `app/routers/tickets.py`
- Auth: `get_current_user` dependency
- Returns `FileResponse` with correct content type
- Logo uploads remain static (public branding, intentionally unauthenticated)

**Access rules:**
- Admin: can view all ticket images
- Non-admin: can view images from own tickets + public tickets (same visibility as ticket list)

**Frontend change:** Ticket image URLs updated from `/static/uploads/tickets/...` to `/api/uploads/tickets/...`.

---

## 3. Upload Magic Number Verification

**Problem:** Only `Content-Type` header checked. Spoofable.

**Implementation:** Manual byte header checks (no `python-magic` — avoids `libmagic` system dependency in Docker image).

**Magic signatures:**

| Format | Magic Bytes |
|---|---|
| PNG | `\x89PNG\r\n\x1a\n` (8 bytes) |
| JPEG | `\xFF\xD8\xFF` (3 bytes) |
| WebP | `RIFF....WEBP` (bytes 0-3 + 8-11) |
| GIF | `GIF87a` or `GIF89a` (6 bytes) — logo upload only |
| SVG | `<?xml` or `<svg` (text prefix) — logo upload only |

**Validation order:**
1. Check Content-Type against allowlist (existing)
2. Read first 12 bytes of file
3. Verify magic bytes match claimed Content-Type
4. Reject with 400 if mismatch

**Location:** `app/utils.py` — `validate_image_magic(file_bytes: bytes, content_type: str) -> bool`

---

## 4. Dependency Pinning

**Workflow:**
- Rename `requirements.txt` → `requirements.in` (human-edited, direct deps only)
- `pip-compile requirements.in` → generates `requirements.txt` with full pinned tree
- `Dockerfile` unchanged (`pip install -r requirements.txt`)
- `pip-tools` is dev-only (not in production image)

**Dependabot:** Add `.github/dependabot.yml` for weekly scans of `requirements.txt`.

---

## 5. Input Validation Hardening

**Targeted fixes for audit-identified gaps:**

- `TestConnectionRequest.service`: validate against allowlist (`plex`, `uptime_kuma`, `overseerr`, `sonarr`, `radarr`, `netdata`)
- Monitor icon field: max length + character validation (alphanumeric, hyphens, slashes for CDN paths)
- Admin tickets `creator` query param: validate non-empty string when provided

Existing Pydantic models are solid — these are gap fills, not a rewrite.

---

## 6. Security Documentation

**Location:** New section in `docs/setup.md` — "Security Considerations"

**Contents:**
- Rate limiting: enforced limits, customization
- Cookie security: HttpOnly, Secure, SameSite settings
- CSP headers: what's blocked, why `unsafe-inline` needed for Tailwind
- File uploads: size limits, type validation, magic number checks
- Authentication: session management, default credentials warning, production setup
- Recommended Cloudflare rules: rate limiting, bot protection, HSTS at proxy level
- Dependency updates: `pip-compile` workflow, Dependabot setup

---

## Out of Scope

- Audit logging (stretch goal for future phase)
- Account lockout
- HSTS headers (reverse proxy responsibility)
- Bot protection (Cloudflare Turnstile)
- Nonce-based CSP (requires Tailwind CDN replacement)
