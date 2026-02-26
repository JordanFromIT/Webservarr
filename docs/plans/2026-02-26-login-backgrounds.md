# Login Page Rotating Backgrounds — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace static stock images on the login page with a crossfade slideshow of TMDB trending backdrops fetched via Overseerr.

**Architecture:** New `get_backdrops()` function in `overseerr.py` calls Overseerr's `/api/v1/backdrops` endpoint. New unauthenticated route in `integrations.py` exposes the URLs. Login page JS fetches backgrounds on load and runs a crossfade slideshow, falling back to the existing static grid when unavailable.

**Tech Stack:** Python/FastAPI (backend), httpx (HTTP client), vanilla JS + CSS transitions (frontend)

---

### Task 1: Add `get_backdrops()` to Overseerr integration

**Files:**
- Modify: `app/integrations/overseerr.py` (append new function at end of file)

**Step 1: Add the function**

Append to end of `app/integrations/overseerr.py`:

```python
async def get_backdrops(db: Session) -> list:
    """
    Fetch trending backdrop image URLs via Overseerr's /api/v1/backdrops endpoint.
    Returns list of full TMDB image URLs. Empty list on failure.
    """
    config = _get_config(db)
    if not config["url"] or not config["api_key"]:
        return []

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.get(
                f"{config['url']}/api/v1/backdrops",
                headers={"X-Api-Key": config["api_key"]},
            )
            if resp.status_code != 200:
                logger.warning("Overseerr backdrops returned HTTP %d", resp.status_code)
                return []

            paths = resp.json()
            if not isinstance(paths, list):
                return []

            return [
                f"https://image.tmdb.org/t/p/original{p}"
                for p in paths
                if isinstance(p, str) and p.startswith("/")
            ]
    except Exception as e:
        logger.debug("Failed to fetch Overseerr backdrops: %s", str(e))
        return []
```

**Step 2: Commit**

```bash
git add app/integrations/overseerr.py
git commit -m "feat: add get_backdrops() to Overseerr integration"
```

---

### Task 2: Add backgrounds endpoint + feature flag setting

**Files:**
- Modify: `app/routers/integrations.py` (add new endpoint)
- Modify: `app/routers/branding.py` (expose feature flag)
- Modify: `app/seed.py` (seed default setting)

**Step 1: Add the endpoint**

Add to `app/routers/integrations.py`, after the existing Plex endpoints section (around line 42), before the Uptime Kuma section:

```python
@router.get("/backgrounds")
async def get_backgrounds(db: Session = Depends(get_db)):
    """
    Get TMDB trending backdrop URLs for login page.
    No auth required — login page is pre-authentication.
    Returns empty list if Overseerr is not configured or feature is disabled.
    """
    from app.models import Setting
    flag = db.query(Setting).filter(Setting.key == "features.login_backgrounds").first()
    if flag and flag.value == "false":
        return []
    return await overseerr.get_backdrops(db)
```

**Step 2: Expose feature flag in branding**

In `app/routers/branding.py`, add to the `features` dict (around line 84):

```python
"login_backgrounds": get("features.login_backgrounds") == "true",
```

Also add to the `DEFAULTS` dict at the top of the file (around line 28):

```python
"features.login_backgrounds": "true",
```

**Step 3: Seed the setting**

In `app/seed.py`, add to `DEFAULT_SETTINGS` after the `features.show_simple_auth` line:

```python
"features.login_backgrounds": ("true", "Show rotating TMDB backgrounds on login page"),
```

**Step 4: Commit**

```bash
git add app/routers/integrations.py app/routers/branding.py app/seed.py
git commit -m "feat: add /api/integrations/backgrounds endpoint and login_backgrounds setting"
```

---

### Task 3: Implement frontend crossfade slideshow

**Files:**
- Modify: `app/static/login.html`

**Step 1: Add slideshow CSS**

In the `<style>` block (after the existing `.login-glass-card` rule, around line 34), add:

```css
.backdrop-slide {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  transition: opacity 1.5s ease-in-out;
  will-change: opacity;
}
```

**Step 2: Add slideshow container to HTML**

Immediately after the opening `<body>` tag (line 37), before the existing `<!-- Cinematic Background Grid -->` comment, add:

```html
<!-- Dynamic Backdrop Slideshow (hidden until JS loads images) -->
<div id="backdropSlideshow" class="fixed inset-0 z-0 hidden">
  <div id="backdropA" class="backdrop-slide opacity-0"></div>
  <div id="backdropB" class="backdrop-slide opacity-0"></div>
</div>
```

**Step 3: Add slideshow JS**

In the `<script>` block, inside the `DOMContentLoaded` handler, add this at the **top** of the function (before the branding/theme code, around line 127):

```javascript
// --- Rotating TMDB Backgrounds ---
(async function() {
    try {
        var resp = await fetch('/api/integrations/backgrounds');
        if (!resp.ok) return;
        var urls = await resp.json();
        if (!Array.isArray(urls) || urls.length === 0) return;

        // Shuffle the array
        for (var i = urls.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = urls[i]; urls[i] = urls[j]; urls[j] = tmp;
        }

        var slideshow = document.getElementById('backdropSlideshow');
        var slideA = document.getElementById('backdropA');
        var slideB = document.getElementById('backdropB');
        var staticGrid = document.querySelector('.fixed.inset-0.z-0 > .grid');
        var currentIndex = 0;
        var activeSlide = 'A';

        // Preload an image and return a promise
        function preload(url) {
            return new Promise(function(resolve, reject) {
                var img = new Image();
                img.onload = function() { resolve(url); };
                img.onerror = function() { reject(); };
                img.src = url;
            });
        }

        // Load first image
        var firstUrl = urls[0];
        await preload(firstUrl);

        // Hide static grid, show slideshow
        if (staticGrid) staticGrid.parentElement.style.display = 'none';
        slideshow.classList.remove('hidden');
        slideA.style.backgroundImage = 'url(' + firstUrl + ')';
        slideA.style.opacity = '1';
        currentIndex = 1;

        // Rotate every 10 seconds
        setInterval(async function() {
            if (urls.length < 2) return;
            var nextUrl = urls[currentIndex % urls.length];
            currentIndex++;

            try {
                await preload(nextUrl);
            } catch(e) { return; } // skip on load failure

            if (activeSlide === 'A') {
                slideB.style.backgroundImage = 'url(' + nextUrl + ')';
                slideB.style.opacity = '1';
                slideA.style.opacity = '0';
                activeSlide = 'B';
            } else {
                slideA.style.backgroundImage = 'url(' + nextUrl + ')';
                slideA.style.opacity = '1';
                slideB.style.opacity = '0';
                activeSlide = 'A';
            }
        }, 10000);

    } catch(e) {
        // Fetch failed — static grid stays visible
    }
})();
```

**Step 4: Commit**

```bash
git add app/static/login.html
git commit -m "feat: add crossfade backdrop slideshow to login page"
```

---

### Task 4: Add feature toggle to settings UI

**Files:**
- Modify: `app/static/settings.html`

**Step 1: Add toggle to Feature Flags section**

In `settings.html`, find the Feature Flags section that has the "Enable local login" toggle. Add a new toggle after it for login backgrounds:

```html
<div class="flex items-center justify-between py-3">
    <div>
        <p class="text-white text-sm font-medium">Login page backgrounds</p>
        <p class="text-steel-blue/70 text-xs">Show rotating TMDB movie backgrounds on the login page. Requires Overseerr.</p>
    </div>
    <label class="relative inline-flex items-center cursor-pointer">
        <input type="checkbox" id="featureLoginBackgrounds" class="sr-only peer" checked>
        <div class="w-11 h-6 bg-steel-blue/30 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
    </label>
</div>
```

**Step 2: Wire up load and save**

In the `loadSettings()` function, in the section that loads feature flags (near the existing `show_simple_auth` / `show_requests` loads), add:

```javascript
var loginBgEl = document.getElementById('featureLoginBackgrounds');
if (loginBgEl) {
    loginBgEl.checked = data.features && data.features.login_backgrounds !== false;
}
```

In the `saveTheme()` function, in the section that saves feature flags, add:

```javascript
settings.push({
    key: 'features.login_backgrounds',
    value: document.getElementById('featureLoginBackgrounds').checked ? 'true' : 'false',
    description: 'Show rotating TMDB backgrounds on login page'
});
```

In the `resetTheme()` function, add:

```javascript
document.getElementById('featureLoginBackgrounds').checked = true;
```

**Step 3: Commit**

```bash
git add app/static/settings.html
git commit -m "feat: add login backgrounds toggle to settings"
```

---

### Task 5: Rebuild, verify, update docs

**Files:**
- Modify: `docs/app-contract.md`

**Step 1: Rebuild container**

```bash
ssh webserver "cd /root/hms-dashboard && docker compose up -d --build hms-dashboard"
```

**Step 2: Verify**

1. Navigate to login page (`/login` or `/auth/logout` first)
2. Confirm TMDB backdrop images load and crossfade every ~10 seconds
3. Confirm dark overlay keeps the login card readable
4. Check console for errors
5. Test fallback: disable the toggle in Settings > Customization > Feature Flags, revisit login — should show static grid

**Step 3: Update app-contract.md**

Add to the login page description:

```
Rotating TMDB backdrop slideshow (via Overseerr /api/v1/backdrops). Falls back to static poster grid.
```

Add the new endpoint to the integrations endpoint table:

```
| GET | `/api/integrations/backgrounds` | None | TMDB trending backdrop URLs for login page (via Overseerr). Empty list if disabled or unavailable. |
```

Add the new setting to the settings table:

```
| `features.login_backgrounds` | `true` | Show rotating TMDB backgrounds on login page (requires Overseerr) |
```

**Step 4: Update Drawbridge task #52 to "done"**

In `.moat/moat-tasks-detail.json`, change task `7c302ce3` status from `"to do"` to `"done"`.

In `.moat/moat-tasks.md`, change task 52 from `[ ]` to `[x]`. Update totals to `To Do: 0 | Done: 62`.

**Step 5: Final commit**

```bash
git add docs/app-contract.md .moat/moat-tasks-detail.json .moat/moat-tasks.md
git commit -m "docs: update contract and mark Drawbridge #52 complete"
git push
```
