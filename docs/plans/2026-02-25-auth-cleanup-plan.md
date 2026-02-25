# Auth Cleanup — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove dormant Plex PIN auth code and make simple auth toggleable via a settings flag.

**Architecture:** Delete Plex PIN endpoints and session helpers. Add `features.show_simple_auth` setting (default: true) that gates both the login form UI and the backend endpoint. Follows the existing feature flag pattern used by `features.show_requests`.

**Tech Stack:** FastAPI, SQLAlchemy Settings model, vanilla JS, Tailwind CSS

---

### Task 1: Remove Plex PIN code from auth.py

**Files:**
- Modify: `app/routers/auth.py`

**Step 1: Delete the Plex PIN constants**

In `app/routers/auth.py`, delete lines 26-30:

```python
PLEX_TIMEOUT = 5.0

# Native Plex PIN auth constants
PLEX_CLIENT_ID = "hms-dashboard"
PLEX_PRODUCT = "HMS Dashboard"
```

Replace with just:

```python
PLEX_TIMEOUT = 5.0
```

**Step 2: Delete the Plex PIN endpoints**

Delete the `PlexStartRequest` model and both endpoints — everything from line 204 to line 342 (the end of `plex_callback`). This is everything between the `oidc_callback` function and the `/me` endpoint. The block to delete starts with:

```python
class PlexStartRequest(BaseModel):
    pin_id: int
```

and ends with:

```python
    return response
```

(just before `@router.get("/me")`).

**Step 3: Clean up unused imports**

After deleting the Plex PIN code, check if `BaseModel` from pydantic is still used. It was only used by `PlexStartRequest`, so remove it:

```python
from pydantic import BaseModel
```

Also check if `Response` from fastapi is still used — it's not, so remove it from the import line. The import line:

```python
from fastapi import APIRouter, Cookie, Depends, HTTPException, status, Response
```

becomes:

```python
from fastapi import APIRouter, Depends, HTTPException, status
```

(`Cookie` was also only used implicitly — verify it's not used elsewhere in the file.)

**Step 4: Commit**

```bash
git add app/routers/auth.py
git commit -m "fix: remove dormant Plex PIN auth endpoints"
```

---

### Task 2: Remove Plex PIN methods from session manager

**Files:**
- Modify: `app/auth.py:223-238`

**Step 1: Delete store_plex_pin and get_plex_pin**

In `app/auth.py`, delete the two methods (lines 223-238):

```python
    async def store_plex_pin(self, state: str, pin_id: int, client_id: str) -> None:
        """Store Plex PIN data temporarily (5 minutes) for native Plex auth flow."""
        redis = await self.get_redis()
        key = f"plex_pin:{state}"
        await redis.hset(key, mapping={"pin_id": str(pin_id), "client_id": client_id})
        await redis.expire(key, 300)

    async def get_plex_pin(self, state: str) -> Optional[Dict[str, str]]:
        """Retrieve and consume Plex PIN data."""
        redis = await self.get_redis()
        key = f"plex_pin:{state}"
        data = await redis.hgetall(key)
        if data:
            await redis.delete(key)
            return {k.decode(): v.decode() for k, v in data.items()}
        return None
```

Leave the blank line before `# Global instances` intact.

**Step 2: Commit**

```bash
git add app/auth.py
git commit -m "fix: remove Plex PIN session manager methods"
```

---

### Task 3: Add simple auth feature flag to backend

**Files:**
- Modify: `app/seed.py`
- Modify: `app/routers/branding.py`
- Modify: `app/routers/simple_auth.py`

**Step 1: Add default setting in seed.py**

In `app/seed.py`, add this entry to the `DEFAULT_SETTINGS` dict, after the `features.show_requests` entry:

```python
    "features.show_simple_auth": ("true", "Show local username/password login on login page"),
```

**Step 2: Add to branding API defaults and response**

In `app/routers/branding.py`, add to the `DEFAULTS` dict after the `features.show_requests` entry:

```python
    "features.show_simple_auth": "true",
```

In the same file, in the `get_branding` response dict, update the `features` block:

```python
        "features": {
            "show_requests": get("features.show_requests") == "true",
            "show_simple_auth": get("features.show_simple_auth") == "true",
        },
```

**Step 3: Add backend guard to simple-login endpoint**

In `app/routers/simple_auth.py`, add these imports at the top (after the existing imports):

```python
from app.models import Setting
```

(`Setting` model is needed to query the feature flag.)

Then at the top of the `simple_login` function, before the user query, add:

```python
    # Check if simple auth is enabled
    simple_auth_setting = db.query(Setting).filter(Setting.key == "features.show_simple_auth").first()
    if simple_auth_setting and simple_auth_setting.value == "false":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Local authentication is disabled",
        )
```

Note: if the setting doesn't exist (no row), default is to allow (enabled by default).

**Step 4: Commit**

```bash
git add app/seed.py app/routers/branding.py app/routers/simple_auth.py
git commit -m "feat: add features.show_simple_auth setting with backend guard"
```

---

### Task 4: Login page conditionally hides simple auth form

**Files:**
- Modify: `app/static/login.html`

**Step 1: Wrap the form and divider in a container**

In `app/static/login.html`, find the login form (line 74) and the "OR CONTINUE WITH" divider (line 94-99). We need to conditionally hide the form, the divider, and the Sign In button — everything from the `<form>` open tag through the divider, but NOT the Plex button.

In the JavaScript section (inside the `DOMContentLoaded` handler, after the branding is applied around line 141), add this code that hides the simple auth form if the feature is disabled:

```javascript
    // Hide simple auth form if disabled
    if (theme.features && theme.features.show_simple_auth === false) {
        var loginForm = document.getElementById('loginForm');
        // Hide everything except the Plex button
        var children = loginForm.children;
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            // Keep the Plex button (id="plexLoginBtn"), hide everything else
            if (child.id !== 'plexLoginBtn') {
                child.style.display = 'none';
            }
        }
    }
```

This hides the username field, password field, Sign In button, and "OR CONTINUE WITH" divider — leaving only the Plex SSO button.

**Step 2: Commit**

```bash
git add app/static/login.html
git commit -m "feat: login page hides simple auth form when disabled"
```

---

### Task 5: Add toggle to Settings Customization tab

**Files:**
- Modify: `app/static/settings.html`

**Step 1: Add the toggle HTML**

In `app/static/settings.html`, find the Custom CSS collapsible section (around line 755). Just before the `<!-- Save / Reset -->` comment (line 768), add a new section:

```html
                <!-- Feature Flags -->
                <div class="bg-cornflower-ocean/10 border border-steel-blue/20 rounded-xl p-6">
                    <h2 class="text-xl font-bold mb-4 text-frosted-blue">Feature Flags</h2>
                    <div class="flex items-center gap-3">
                        <label class="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" id="featureShowSimpleAuth" class="sr-only peer" checked>
                            <div class="w-9 h-5 bg-steel-blue/30 peer-focus:ring-2 peer-focus:ring-primary rounded-full peer peer-checked:bg-primary transition-colors"></div>
                            <div class="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full peer-checked:translate-x-4 transition-transform"></div>
                        </label>
                        <div>
                            <span class="text-sm text-frosted-blue">Enable local login</span>
                            <p class="text-xs text-steel-blue/70 mt-0.5">Show username/password form on the login page. Disable after configuring Plex/Authentik.</p>
                        </div>
                    </div>
                </div>
```

**Step 2: Load the setting value**

In the `loadThemeSettings()` function (around line 1681), find where the branding API response is processed. After the existing icon loading code, add:

```javascript
                // Feature flags
                if (data.features) {
                    document.getElementById('featureShowSimpleAuth').checked = data.features.show_simple_auth !== false;
                }
```

**Step 3: Save the setting value**

In the `btnSaveTheme` click handler (around line 1752), find the settings array. After the icons section (after the `for (var iconKey in iconSaveMap)` loop, around line 1797), add:

```javascript
            // Feature flags
            settings.push({
                key: 'features.show_simple_auth',
                value: document.getElementById('featureShowSimpleAuth').checked ? 'true' : 'false',
                description: 'Show local username/password login on login page'
            });
```

**Step 4: Commit**

```bash
git add app/static/settings.html
git commit -m "feat: add simple auth toggle to Settings Customization tab"
```

---

### Task 6: Rebuild, verify, and test live

**Step 1: Rebuild container**

```bash
ssh webserver "cd /root/hms-dashboard && docker compose up -d --build hms-dashboard"
```

**Step 2: Verify login page shows both forms (default)**

Use Chrome DevTools MCP to navigate to `https://dev.hmserver.tv/login`. Verify:
- Username/password form is present
- "Sign in with Plex" button is present
- No console errors

**Step 3: Test simple auth still works**

Log in with username `admin`, password `admin123`. Verify dashboard loads.

**Step 4: Test the toggle**

Navigate to Settings > Customization tab. Find "Enable local login" toggle. Uncheck it. Save.

**Step 5: Verify login page hides form**

Log out. Navigate to `/login`. Verify:
- Username/password form is hidden
- Only "Sign in with Plex" button is visible

**Step 6: Verify backend guard**

Test that the endpoint rejects direct POST:

```bash
ssh webserver "curl -s -X POST http://localhost:8000/auth/simple-login -H 'Content-Type: application/json' -d '{\"username\":\"admin\",\"password\":\"admin123\"}'"
```

Expected: 403 response with "Local authentication is disabled".

**Step 7: Re-enable and verify**

Re-enable the toggle (need to use Plex OIDC to log in since simple auth is disabled, or re-enable via direct DB). Verify the form reappears.

---

### Task 7: Update docs

**Files:**
- Modify: `docs/app-contract.md`

**Step 1: Update auth documentation**

In `docs/app-contract.md`, update to reflect:
- Plex PIN endpoints (`/auth/plex-start`, `/auth/plex-callback`) removed entirely
- New setting: `features.show_simple_auth` (default: true)
- Simple auth can be disabled via settings when Plex/Authentik is configured

**Step 2: Commit**

```bash
git add docs/app-contract.md
git commit -m "docs: update auth docs for Plex PIN removal and simple auth toggle"
```
