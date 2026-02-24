> Archived 2026-02-22. Content available in docs/setup.md and docs/app-contract.md. Kept for historical reference.

# HMS Dashboard - Quick Start Guide

This guide walks through the first-time experience of using the deployed HMS Dashboard.

---

## 1. Log In

Open the dashboard URL in a browser. You will be redirected to the login page.

Enter the default credentials:
- **Username:** `admin`
- **Password:** `admin123`

Click "Sign In". On success, you will be redirected to the main dashboard.

These credentials are created automatically on first startup by `app/seed.py`. Change the password directly in the database or by adding a password-change feature (not yet built).

---

## 2. Dashboard Overview

The main dashboard at `/` shows four live data sections:

**Plex Streams** - If Plex is configured (see step 4), this section shows who is currently watching and what they are watching. Admin users see action buttons to kill a stream, scan libraries, or empty trash. If Plex is not configured, a message explains that no integration is set up.

**Overseerr Requests** - If Overseerr is configured, shows recent media requests and a count summary (pending, approved, available). Otherwise shows an empty state.

**Service Status** - Shows service tiles with up/degraded/down indicators. If Uptime Kuma is configured, health data comes from its public status page API. Otherwise, status comes from the local database (managed via the settings page).

**News** - Displays published news posts. Pinned posts appear first.

All sections refresh automatically every 30 seconds.

**Note:** The "Upcoming Releases" calendar and "Server Load" footer sections display static placeholder data. They are not connected to real data sources.

---

## 3. Create a News Post

Navigate to `/admin` (or click "Admin" in the navigation bar).

Click "Create New Post". The rich text editor provides:
- Toolbar buttons for bold, italic, underline, headings, lists, and links
- Keyboard shortcuts (Ctrl+B for bold, Ctrl+I for italic, etc.)
- A preview toggle to see the rendered output

Write your post content, set a title, and choose whether to publish it immediately or save as a draft. Pinned posts will appear at the top of the news feed on the dashboard.

Click "Save Post". The post is stored in the database with HTML content sanitized by bleach.

Return to the dashboard to see your published post appear in the News section.

---

## 4. Configure Integrations

Navigate to `/settings` and click the "Integrations" tab.

Three integrations are available:

**Plex:**
- Enter your Plex server URL (e.g., `http://192.168.1.100:32400`)
- Enter your Plex API token
- Click "Test Connection" to verify the credentials work
- Click "Save" to store the configuration

**Uptime Kuma:**
- Enter your Uptime Kuma URL (e.g., `https://status.example.com`)
- Enter your status page slug (the path segment from your public status page URL)
- Click "Test Connection" to verify
- Click "Save"

**Overseerr:**
- Enter your Overseerr server URL
- Enter your Overseerr API key
- Click "Test Connection" to verify
- Click "Save"

After saving, API keys and tokens are masked in the UI (only the last few characters are visible). The dashboard will begin showing live data from configured integrations on the next refresh cycle (up to 30 seconds).

---

## 5. Manage Services

On the `/settings` page, the "Services" tab allows you to create, edit, and delete services that appear on the dashboard.

Each service has:
- **Name** - Internal identifier
- **Display name** - Shown on the dashboard
- **Description** - Brief description
- **URL** - Link to the service
- **Icon** - Material Design icon name (e.g., `play_circle`, `movie`, `dns`)
- **Status** - up, degraded, or down
- **Enabled** - Whether it appears on the dashboard

Changes take effect immediately on the dashboard.

If Uptime Kuma is configured, its health data takes priority over the manually set status for matching services.

---

## 6. Log Out

Click "Logout" in the navigation bar. Your session is cleared from Redis and the session cookie is removed. You will be redirected to the login page.

---

## Pages Summary

| URL | What it does |
|-----|-------------|
| `/login` | Login form |
| `/` | Main dashboard with live Plex, Overseerr, service status, and news |
| `/admin` | News post management with rich text editor |
| `/settings` | Service CRUD, integration configuration, system settings |

All pages except `/login` require authentication. All write operations require the admin role.
