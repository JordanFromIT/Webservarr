# Ticket System Design

## Goal

A native support ticket system where Plex users submit categorized requests to the server admin, with threaded comments, image attachments, and full notification integration.

## Architecture

Native SQLite implementation following existing WebServarr patterns. Two new models (Ticket, TicketComment), one new API router, one new frontend page, and an extension to the notification poller. No external dependencies.

## Data Model

### Ticket

| Column | Type | Notes |
|--------|------|-------|
| id | Integer PK | Auto-increment |
| title | String(200) | Required, bleach-sanitized |
| description | Text | Required, bleach-sanitized |
| category | String(50) | "media_request", "playback_issue", "account_issue", "feature_suggestion", "other" |
| status | String(20) | "open", "in_progress", "resolved", "closed" |
| priority | String(20) | Nullable, admin-only: "low", "medium", "high", "urgent" |
| is_public | Boolean | Default False. Admin toggle. When True, all authenticated users can see it. |
| creator_username | String | Plex username from session |
| creator_name | String | Display name from session (visible to admin only) |
| image_path | String | Nullable, path to uploaded screenshot |
| created_at | DateTime | Auto-set |
| updated_at | DateTime | Auto-updated on any change |

### TicketComment

| Column | Type | Notes |
|--------|------|-------|
| id | Integer PK | Auto-increment |
| ticket_id | Integer FK | References Ticket.id, cascade delete |
| author_username | String | Plex username from session |
| author_name | String | Display name (visible to admin only) |
| is_admin | Boolean | True if posted by admin |
| message | Text | Bleach-sanitized |
| image_path | String | Nullable, screenshot attachment |
| created_at | DateTime | Auto-set |

### User Identification

Users identified by Plex username from session (not email). Follows same sessionless pattern as Notification model — no foreign key to User table since Plex/OIDC users don't have User rows.

## Privacy Rules

- **Non-admin users:** See only their own tickets + tickets where `is_public=True`. Never see other users' usernames. Public tickets show no creator attribution.
- **Admin:** Sees all tickets with creator username and display name.
- **Comments:** Non-admin users see "Admin" label on admin comments. On public tickets viewed by non-creators, comment authors are hidden. Users cannot comment on other users' tickets (only their own).

## API Endpoints

### User Endpoints (Session Auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tickets` | List my tickets + public tickets. Query params: `status`, `category`. Paginated. |
| POST | `/api/tickets` | Create ticket (multipart: title, description, category, optional image) |
| GET | `/api/tickets/{id}` | Ticket detail + comments (only if mine, public, or admin) |
| POST | `/api/tickets/{id}/comments` | Add comment (only if my ticket or admin). Multipart for optional image. |
| GET | `/api/tickets/counts` | My ticket counts by status (for stat cards) |

### Admin Endpoints (Admin Auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/tickets` | All tickets. Query params: `status`, `category`, `priority`, `creator_username`. Paginated. |
| PUT | `/api/admin/tickets/{id}` | Update status, priority, is_public |
| DELETE | `/api/admin/tickets/{id}` | Delete ticket and associated comments |

### Image Upload

- Multipart form-data on ticket create and comment create
- Validation: 2MB max, PNG/JPEG/WebP only
- Storage: `uploads/tickets/{ticket_id}.{ext}` and `uploads/tickets/comments/{comment_id}.{ext}`
- Follows existing logo upload pattern in admin.py

## Frontend Page: `tickets.html`

### Layout

Two-column like issues.html — ticket list on left, detail panel on right. Stacked on mobile.

### Left Column — Ticket List

- "New Ticket" button at top
- Filter tabs: All | Open | In Progress | Resolved | Closed
- Stat cards: Open / In Progress / Resolved counts
- Ticket cards: title, category badge, status badge, priority badge (if set), relative time
- Admin view: shows creator username on each card
- Pagination (same pattern as requests2.html)

### Right Column — Ticket Detail

- Title, description, category, status, priority, created time
- Image attachment (clickable to enlarge)
- Comment thread (chronological, newest at bottom)
- Comments: message, relative time, "Admin" badge for admin comments, image if attached
- Comment input with "Add Comment" button + optional image
- Admin controls: status dropdown, priority dropdown, public/private toggle

### Create Ticket Modal

- Title input
- Category dropdown: Media Request, Playback Issue, Account Issue, Feature Suggestion, Other
- Description textarea
- Optional image upload (file picker)
- Submit button

### Styling

Glass-card components, brand color badges, Tailwind + CSS custom properties. Zero innerHTML (createElement/textContent only). Material Design Icons.

## Notification Integration

### Poller Extension

Add ticket polling to `notification_poller.py`:
- Poll TicketComment table for new comments where user is the ticket creator
- Poll Ticket table for status changes (open → in_progress → resolved → closed)
- Redis state: `poller:ticket:{id}:status`, `poller:ticket:{id}:comment_count`
- Dedup: `reference_id` = `ticket-{id}-comment-{comment_id}` or `ticket-{id}-status-{status}`

### Notification Messages

- New admin comment: "New response on your ticket: '{title}'"
- Status change: "Your ticket '{title}' was marked as {status}"

### User Preferences

- New "Tickets" category in notification preferences modal (alongside Requests, Issues, Services, News)
- Stored as: `notify.{email_hash}.ticket` in Settings table
- Default: enabled
- Toggles both in-app bell and browser push

## Settings Integration

### Feature Toggle

- `features.show_tickets` — default "true", seeded in seed.py
- When "false": sidebar hides ticket link, API returns 403

### Sidebar Config

- `sidebar.label_tickets` — default "Tickets", configurable label
- `icon.nav_tickets` — default Material Symbol icon, configurable

### Seed Defaults

Add to seed.py alongside existing sidebar/icon/feature seeds.

## Phase Placement

This is Phase 8 (or integrated into Phase 7 hardening, depending on timeline). Builds on:
- Phase 1 (auth — user sessions with username)
- Phase 2 (frontend — sidebar, theme engine, glass-card styling)
- Phase 6 (notifications — poller, push, preferences)
