# Authentik OIDC Restoration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore Authentik OIDC as the primary "Sign in with Plex" flow, replacing the native Plex PIN flow with full-page redirects.

**Architecture:** The login page's "Sign in with Plex" button redirects to `/auth/login`, which redirects to Authentik (auto-forwarding to Plex OAuth). After Plex auth, Authentik redirects back to `/auth/callback`, which creates a session and redirects to `/`. No popups, no client-side Plex API calls.

**Tech Stack:** FastAPI, Authentik OIDC, authlib, Redis sessions, vanilla JS

---

### Task 1: Fix OIDC callback to use full-page redirect

**Files:**
- Modify: `app/routers/auth.py:168-201`

**Context:** The OIDC callback currently returns an HTML page that uses `window.opener.postMessage` to close a popup window. This was for the old popup-based flow. We need it to be a normal redirect instead.

**Step 1: Replace the popup HTML response with RedirectResponse**

In `app/routers/auth.py`, find the block starting at line 168 (inside `oidc_callback`):

```python
        # Set session cookie and notify the opener window to redirect
        # The callback runs inside a popup — send postMessage to close it
        close_html = """<!DOCTYPE html>
<html><body><script>
if (window.opener) {
    window.opener.postMessage('auth-success', window.location.origin);
    window.close();
} else {
    window.location.href = '/';
}
</script></body></html>"""
        response = HTMLResponse(content=close_html)
```

Replace with:

```python
        # Redirect to dashboard after successful OIDC authentication
        response = RedirectResponse(url="/", status_code=302)
```

Leave everything else in the function unchanged — the cookie-setting code that follows already works with RedirectResponse.

**Step 2: Clean up unused import**

Check if `HTMLResponse` is still used elsewhere in the file. If not, remove it from the imports at line 8:

```python
from fastapi.responses import RedirectResponse, HTMLResponse
```

becomes:

```python
from fastapi.responses import RedirectResponse
```

(Keep `HTMLResponse` only if other routes in the file use it.)

**Step 3: Commit**

```bash
git add app/routers/auth.py
git commit -m "fix: OIDC callback uses redirect instead of popup postMessage"
```

---

### Task 2: Rewire login page Plex button to OIDC flow

**Files:**
- Modify: `app/static/login.html:183-227`

**Context:** The "Sign in with Plex" button currently runs ~45 lines of JavaScript that creates a Plex PIN via `plex.tv/api/v2/pins`, stores it on the backend via `/auth/plex-start`, then redirects to `app.plex.tv/auth`. This needs to become a single redirect to `/auth/login`.

**Step 1: Replace the Plex PIN JavaScript**

In `app/static/login.html`, find the block starting at line 183:

```javascript
    // Plex login — native PIN auth flow (no popups at all).
    // PIN created from the browser so Plex sees the user's IP, not the server's.
    const plexLoginBtn = document.getElementById('plexLoginBtn');
    const plexBtnHTML = plexLoginBtn.innerHTML;
    plexLoginBtn.addEventListener('click', async function() {
        // ... ~40 lines of PIN creation logic ...
    });
```

Replace the entire block (lines 183-227) with:

```javascript
    // Plex login via Authentik OIDC — full-page redirect, no popups.
    // Authentik auto-redirects to Plex OAuth, then back to /auth/callback.
    document.getElementById('plexLoginBtn').addEventListener('click', function() {
        window.location.href = '/auth/login';
    });
```

**Step 2: Commit**

```bash
git add app/static/login.html
git commit -m "feat: Plex button redirects through Authentik OIDC instead of native PIN"
```

---

### Task 3: Remove plex.tv from CSP connect-src

**Files:**
- Modify: `app/main.py:95`

**Context:** The CSP `connect-src` includes `https://plex.tv` because the old Plex PIN flow made a `fetch()` call to `plex.tv/api/v2/pins` from the browser. With the OIDC flow, the browser never calls plex.tv directly (all Plex communication happens server-side through Authentik). Remove it.

**Step 1: Remove plex.tv from connect_sources**

In `app/main.py`, change line 95:

```python
    connect_sources = ["'self'", "https://plex.tv"]
```

to:

```python
    connect_sources = ["'self'"]
```

The Authentik URL is already added conditionally on line 96-97, so that stays.

**Step 2: Commit**

```bash
git add app/main.py
git commit -m "fix: remove plex.tv from CSP connect-src (no longer called from browser)"
```

---

### Task 4: Rebuild, verify, and test live

**Step 1: Rebuild container**

```bash
ssh webserver "cd /root/hms-dashboard && docker compose up -d --build hms-dashboard"
```

**Step 2: Verify login page loads**

Use Chrome DevTools MCP to navigate to `https://dev.hmserver.tv/login`. Take a snapshot. Confirm:
- Username/password form is present
- "Sign in with Plex" button is present
- No console errors

**Step 3: Test Plex OIDC flow**

Click the "Sign in with Plex" button. Verify:
- Browser redirects to Authentik (auth.hmserver.tv)
- Authentik redirects to Plex OAuth (or shows Plex login option)

**PAUSE HERE** — The user needs to authenticate with Plex manually. Wait for the user to confirm they've completed the Plex login.

**Step 4: Verify callback**

After Plex auth completes, verify:
- Browser ends up at `https://dev.hmserver.tv/` (not a popup close page)
- Dashboard loads with user info in header
- Check session via `/auth/check-session` — confirm `authenticated: true`

**Step 5: Verify session data**

```bash
ssh webserver "docker compose exec redis redis-cli --no-auth-warning keys 'session:*'"
```

Pick the most recent session and check its auth_method:

```bash
ssh webserver "docker compose exec redis redis-cli --no-auth-warning hgetall 'session:<session_id>'"
```

Confirm `auth_method` is `oidc` and `plex_token` is populated.

**Step 6: Test logout**

Click Sign Out. Verify redirect to `/login` (not stuck on blank page).

**Step 7: Test simple auth fallback**

Log in with username `admin`, password `admin123`. Verify dashboard loads.

---

### Task 5: Authentik flow configuration (manual admin task)

**Context:** This is a manual configuration change in the Authentik admin UI, not a code change. The user needs to configure the HMS Dashboard authentication flow in Authentik to auto-redirect to the Plex source instead of showing an Authentik login page.

**Step 1: Guide the user**

Tell the user to:
1. Open `https://auth.hmserver.tv/if/admin/`
2. Go to Flows & Stages → Flows
3. Find the flow used by the HMS Dashboard application (likely "Plex Direct Login" or similar)
4. Edit the flow to auto-redirect to the Plex source (skip the Authentik identification stage)

This step may need to happen before or after the code changes — the OIDC flow will work either way, it just means users see the Authentik page until auto-redirect is configured.

---

### Task 6: Update docs

**Files:**
- Modify: `docs/app-contract.md`

**Step 1: Update auth documentation**

In the auth section of `docs/app-contract.md`, update to reflect:
- Primary login: Plex via Authentik OIDC (full-page redirect)
- Fallback: simple username/password
- Native Plex PIN endpoints still exist but are dormant

**Step 2: Commit**

```bash
git add docs/app-contract.md
git commit -m "docs: update auth documentation for OIDC restoration"
```
