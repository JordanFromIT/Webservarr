# Phase 6: In-App Notifications + Browser Push

**Date:** 2026-02-24
**Status:** Approved design, pending implementation

---

## Overview

Add a user-facing notification system to HMS Dashboard. Non-admin users receive notifications for: media request availability, issue responses/resolutions, service up/down changes, and new news posts. Delivered via an in-app bell icon dropdown and optional browser push notifications.

Theming was originally scoped for Phase 6 but is already ~95% complete from Phase 2 work (CSS custom properties, branding API, color pickers, font dropdown, logo upload, custom CSS injection). No theming work is needed.

---

## Data Model

### New Table: `Notification`

| Column | Type | Purpose |
|--------|------|---------|
| id | Integer PK | Auto-increment |
| user_email | String(200), indexed | Recipient identifier (matched from session email) |
| category | String(20) | `request`, `issue`, `service`, `news` |
| title | String(200) | e.g. "Your request is available" |
| body | Text | e.g. "Interstellar is now available on Plex" |
| reference_id | String(100), nullable | External ID (Overseerr request ID, monitor ID, news post ID) |
| read | Boolean, default False | Read/unread state |
| created_at | DateTime, server_default now | Creation timestamp |

### New Table: `PushSubscription`

| Column | Type | Purpose |
|--------|------|---------|
| id | Integer PK | Auto-increment |
| user_email | String(200), indexed | Owner |
| endpoint | Text | Push service URL |
| p256dh | String(200) | Client public key |
| auth | String(200) | Auth secret |
| created_at | DateTime, server_default now | Registration timestamp |

### Settings Keys (existing `Setting` table)

**Polling intervals** (seeded in `seed.py`, editable in Settings > Integrations):

| Key | Default | Purpose |
|-----|---------|---------|
| `notifications.poll_interval_overseerr` | `"60"` | Seconds between Overseerr request/issue checks |
| `notifications.poll_interval_monitors` | `"60"` | Seconds between Uptime Kuma monitor checks |
| `notifications.poll_interval_news` | `"60"` | Seconds between news post checks |

**VAPID keys** (auto-generated on first startup, never shown in UI):

| Key | Default | Purpose |
|-----|---------|---------|
| `notifications.vapid_public_key` | (generated) | Web Push VAPID public key |
| `notifications.vapid_private_key` | (generated) | Web Push VAPID private key |

**Per-user preferences** (created on first toggle, stored as Settings):

| Key pattern | Default | Purpose |
|-------------|---------|---------|
| `notify.{email_hash}.request` | `"true"` | Receive request-available notifications |
| `notify.{email_hash}.issue` | `"true"` | Receive issue-response notifications |
| `notify.{email_hash}.service` | `"true"` | Receive service up/down notifications |
| `notify.{email_hash}.news` | `"true"` | Receive news-post notifications |

`email_hash` = first 16 chars of SHA-256 hex digest of lowercased email. Avoids special characters in Setting keys.

---

## Backend Polling Service

**New file:** `app/services/notification_poller.py`

A background asyncio task launched on FastAPI startup. Runs three independent polling loops at configurable intervals. Reads interval settings from the DB on each cycle (changes take effect without restart).

### Overseerr Requests (default: every 60s)

1. Fetch all requests via `GET /api/v1/request` (using API key from settings)
2. Compare each request's status against a Redis snapshot (`poller:request:{request_id}` → last known status string)
3. When status transitions to `available`:
   - Look up `requestedBy.email` from the Overseerr response
   - Create a `Notification` row for that email with category `request`
   - Title: "Your request is available"
   - Body: "{media_title} is now available on Plex"
   - Send browser push to matching `PushSubscription` records
4. Update Redis snapshot with new status

### Overseerr Issues (default: every 60s, same loop as requests)

1. Fetch open issues via `GET /api/v1/issue`
2. For each issue, fetch detail to get comment count
3. Compare against Redis snapshot (`poller:issue:{issue_id}` → `{comment_count}:{status}`)
4. When comment count increases:
   - Look up issue creator email from Overseerr response
   - Create `Notification` with category `issue`, title "New response on your issue"
   - Body: "{media_title} — {issue_type} issue has a new comment"
5. When status changes to `resolved`:
   - Create `Notification` with title "Your issue has been resolved"
6. Send browser push, update Redis snapshot

### Uptime Kuma Monitors (default: every 60s)

1. Fetch monitors via existing `get_monitors()` function
2. Compare against Redis snapshot (`poller:monitor:{monitor_id}` → last known status)
3. On status change (up↔down, up↔degraded, etc.):
   - Get all user emails from active Redis sessions (scan `session:*` keys, collect emails)
   - Create a `Notification` per user with category `service`
   - Title: "{service_name} is {up/down/degraded}"
   - Body: status message from Uptime Kuma
   - Send browser push to all matching subscriptions
4. Update Redis snapshot

### News Posts (default: every 60s)

1. Query `NewsPost` table for rows with `published=True` and `published_at` newer than Redis timestamp (`poller:news:last_check`)
2. For each new post:
   - Get all known user emails (union of active sessions + PushSubscription table)
   - Create a `Notification` per user with category `news`
   - Title: "New announcement"
   - Body: news post title
3. Send browser push, update Redis timestamp

### Graceful Behavior

- **First run:** Seeds Redis snapshots without generating notifications (prevents flood on container restart)
- **Unreachable services:** Skip that cycle, log warning, no false alerts
- **Unconfigured integrations:** Poller skips Overseerr loop if no URL/API key, skips Uptime Kuma if no URL
- **User preferences:** Before creating a Notification, check the user's `notify.{hash}.{category}` setting. If `"false"`, skip that user for that category.

---

## API Endpoints

### New Router: `app/routers/notifications.py`

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/notifications` | Session | Fetch user's notifications. Query: `unread_only` (bool), `limit` (int, default 20), `offset` (int, default 0). Returns `{ "notifications": [...], "total": N }` |
| GET | `/api/notifications/unread-count` | Session | Returns `{ "count": N }` |
| PUT | `/api/notifications/{id}/read` | Session | Mark one as read. Verifies ownership by email. |
| PUT | `/api/notifications/read-all` | Session | Mark all of user's notifications as read |
| DELETE | `/api/notifications/{id}` | Session | Delete one notification. Verifies ownership. |
| GET | `/api/notifications/preferences` | Session | Get user's 4 category toggles (defaults to all true) |
| PUT | `/api/notifications/preferences` | Session | Update toggles. Body: `{ "request": true, "issue": true, "service": false, "news": true }` |
| POST | `/api/notifications/push-subscribe` | Session | Register push subscription. Body: `{ "endpoint": "...", "keys": { "p256dh": "...", "auth": "..." } }` |
| DELETE | `/api/notifications/push-subscribe` | Session | Remove push subscription for this user + endpoint |

### Admin Endpoint (added to `app/routers/admin.py`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/admin/notifications/send` | Admin | Send a custom notification to all users. Body: `{ "title": "...", "body": "..." }` |

### Branding API Addition

`GET /api/branding` response gains one field:

```json
{
  "vapid_public_key": "BNx..."
}
```

Returned only if VAPID keys exist in settings. Used by the frontend to subscribe to push.

---

## Frontend

### Shared Notification JS: `app/static/js/notifications.js`

Loaded on every page via `<script>` tag, like `sidebar.js` and `theme-loader.js`.

**`initNotifications()`** — called from every page's `DOMContentLoaded`:

1. Finds the existing bell button in the top bar (or injects one if missing)
2. Fetches `GET /api/notifications/unread-count` → shows/hides red badge with count
3. Polls unread count every 30 seconds
4. Attaches click handler to toggle the dropdown panel

**Bell icon + badge:**
- Red circle badge overlaid on the existing bell button (absolute positioned)
- Hidden when count is 0
- Animates briefly on count increase (subtle pulse)

**Dropdown panel:**
- Appears below the bell, right-aligned (same z-index/pattern as existing user menu dropdown)
- Uses `.glass-card` styling from `theme.css`
- Shows last 10 notifications, newest first
- Each item: category icon (Material Symbol) + title + body truncated + relative time + unread blue dot
- Click item → marks read via `PUT /api/notifications/{id}/read` + navigates to relevant page:
  - `request` → `/requests2`
  - `issue` → `/issues`
  - `service` → `/`
  - `news` → `/` (scrolls to news section)
- "Mark all as read" link at top of panel
- "Notification settings" link at bottom → opens preferences modal
- Built with `createElement`/`textContent` (no innerHTML, per security hook)

**Preferences modal:**
- Small overlay with 4 toggle switches: Requests, Issues, Service Status, News
- Push notification opt-in toggle:
  - If browser supports push and permission not yet granted → "Enable push notifications" toggle
  - On enable: requests browser permission → if granted, gets subscription → `POST /api/notifications/push-subscribe`
  - On disable: `DELETE /api/notifications/push-subscribe`
- Loads current state from `GET /api/notifications/preferences`
- Saves via `PUT /api/notifications/preferences`

### Service Worker: `app/static/sw.js`

Registered by `notifications.js` when push is enabled.

**`push` event handler:**
- Parses payload JSON: `{ "title": "...", "body": "...", "category": "...", "url": "..." }`
- Shows native OS notification via `self.registration.showNotification()`
- Icon: `/static/uploads/logo.png` or a default icon

**`notificationclick` event handler:**
- Opens or focuses the dashboard tab
- Navigates to the URL from the payload

### CSS Additions to `theme.css`

Minimal — notification dropdown panel, unread dot, badge counter. Uses existing CSS custom properties and `.glass-card` pattern.

---

## Settings UI

### Integrations Tab — New "Notifications" Accordion Panel

Added alongside existing Uptime Kuma, Overseerr, Radarr, Sonarr panels in `settings.html`.

Contains 3 number inputs:

- **Overseerr poll interval** — seconds (default 60, min 30)
- **Monitor poll interval** — seconds (default 60, min 30)
- **News poll interval** — seconds (default 60, min 30)

Plus a **"Send test notification"** button that calls `POST /api/admin/notifications/send` with a test payload, so the admin can verify push is working.

---

## Dependencies

**New Python package:** `pywebpush` — for sending Web Push notifications via VAPID.

Add to `requirements.txt`:
```
pywebpush>=2.0.0
```

**VAPID key generation:** Uses `py_vapid` (included with pywebpush) to generate keys on first startup. Stored in Settings table.

No new frontend dependencies (Web Push API is native browser).

---

## Files Created/Modified

### New Files
| File | Purpose |
|------|---------|
| `app/services/__init__.py` | Package init |
| `app/services/notification_poller.py` | Background polling loops + push dispatch |
| `app/routers/notifications.py` | Notification API endpoints |
| `app/static/js/notifications.js` | Bell icon, dropdown, preferences, push subscription |
| `app/static/sw.js` | Service worker for browser push |

### Modified Files
| File | Change |
|------|--------|
| `app/models.py` | Add `Notification` and `PushSubscription` models |
| `app/seed.py` | Seed polling interval settings + generate VAPID keys |
| `app/main.py` | Register notifications router, start/stop poller on lifespan |
| `app/routers/admin.py` | Add `POST /api/admin/notifications/send` |
| `app/routers/branding.py` | Add `vapid_public_key` to response |
| `app/static/settings.html` | Add Notifications accordion in Integrations tab |
| `app/static/index.html` | Wire bell button, load `notifications.js` |
| `app/static/requests2.html` | Load `notifications.js` |
| `app/static/issues.html` | Load `notifications.js` |
| `app/static/calendar.html` | Load `notifications.js` |
| `app/static/settings.html` | Load `notifications.js` |
| `app/static/login.html` | Register service worker (for push to work after login) |
| `requirements.txt` | Add `pywebpush` |
| `docs/app-contract.md` | Document new endpoints, models, settings |

---

## Edge Cases

- **Container restart:** First poller run seeds snapshots silently — no notification flood
- **Duplicate notifications:** `reference_id` + `user_email` + `category` checked before creating (skip if exists)
- **Stale push subscriptions:** If `pywebpush` returns 410 Gone, delete the `PushSubscription` row
- **No email in session:** Simple auth users without email set → skip per-user notifications, still get service/news if a catch-all is desired (or skip entirely — they're admin-only anyway)
- **Overseerr user matching:** Match on `requestedBy.email` from Overseerr API. If email is missing in Overseerr response, notification cannot be routed — skip silently
- **Notification cleanup:** No auto-pruning in v1. Could add a "delete notifications older than 30 days" setting later.
