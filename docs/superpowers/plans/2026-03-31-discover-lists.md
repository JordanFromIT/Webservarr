# Seerr Discover Lists + Detail Modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five Seerr Discover list rows (Trending, Popular Movies, Upcoming Movies, Popular Series, Upcoming Series) above the stat cards on `requests.html`, with a detail/request modal that opens when clicking a discover card.

**Architecture:** A single `get_discover_list(list_type)` backend function normalizes all five Seerr discover endpoints into the same shape as `search_media` results. Five slim authenticated routes proxy them. The frontend builds the discover section dynamically, stores item data on card elements, and opens a modal populated entirely from in-memory data — no second API call.

**Tech Stack:** FastAPI, httpx, SQLAlchemy (settings read), vanilla JS, Tailwind CSS CDN, Material Symbols Outlined

---

## File Map

| File | Change |
|---|---|
| `app/integrations/seerr.py` | Add `DISCOVER_ENDPOINT_MAP` dict and `get_discover_list(list_type, page)` function |
| `app/routers/integrations.py` | Add 5 new GET routes under `/seerr-discover/` |
| `app/static/requests.html` | Add discover section HTML, modal HTML, discover/modal CSS, discover/modal JS |

---

## Task 1: Backend — `get_discover_list()` in `seerr.py`

**Files:**
- Modify: `app/integrations/seerr.py` (append after `get_backdrops`)

- [ ] **Step 1: Add the endpoint map and function**

Open `app/integrations/seerr.py`. After the `get_backdrops` function at the bottom of the file, add:

```python
# Discover list type → Seerr endpoint path
DISCOVER_ENDPOINT_MAP = {
    "trending": "/api/v1/discover/trending",
    "popular-movies": "/api/v1/discover/movies",
    "upcoming-movies": "/api/v1/discover/movies/upcoming",
    "popular-series": "/api/v1/discover/tv",
    "upcoming-series": "/api/v1/discover/tv/upcoming",
}


async def get_discover_list(list_type: str, page: int = 1) -> list:
    """
    Fetch a Seerr discover list and normalize results to the same shape as search_media.
    list_type: one of "trending", "popular-movies", "upcoming-movies",
               "popular-series", "upcoming-series"
    Returns empty list on config missing, unknown list_type, HTTP error, or timeout.
    """
    config = _get_config()
    if not config["url"] or not config["api_key"]:
        return []

    endpoint = DISCOVER_ENDPOINT_MAP.get(list_type)
    if not endpoint:
        logger.warning("Unknown discover list type: %s", list_type)
        return []

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{config['url']}{endpoint}",
                params={"page": page, "language": "en"},
                headers={"X-Api-Key": config["api_key"]},
            )
            if resp.status_code != 200:
                logger.warning("Seerr discover/%s returned HTTP %d", list_type, resp.status_code)
                return []

            data = resp.json()
            results = []
            for item in data.get("results", []):
                media_type = item.get("mediaType", "")
                if media_type not in ("movie", "tv"):
                    continue

                title = item.get("title") or item.get("name", "Unknown")
                release_date = item.get("releaseDate") or item.get("firstAirDate", "")
                year = release_date[:4] if release_date else ""

                poster_path = item.get("posterPath", "")
                poster_url = f"https://image.tmdb.org/t/p/w300{poster_path}" if poster_path else ""

                media_info = item.get("mediaInfo")
                media_status = None
                media_status_4k = None
                if media_info:
                    status_code = media_info.get("status", 0)
                    if status_code and status_code > 1:
                        media_status = MEDIA_STATUS_MAP.get(status_code)
                    status_code_4k = media_info.get("status4k", 0)
                    if status_code_4k and status_code_4k > 1:
                        media_status_4k = MEDIA_STATUS_MAP.get(status_code_4k)

                results.append({
                    "id": item.get("id", 0),
                    "media_type": media_type,
                    "title": title,
                    "year": year,
                    "overview": item.get("overview", ""),
                    "poster_url": poster_url,
                    "vote_average": round(item.get("voteAverage", 0), 1),
                    "media_status": media_status,
                    "media_status_4k": media_status_4k,
                    "media_info_id": media_info.get("id") if media_info else None,
                })

            return results

    except httpx.TimeoutException:
        logger.warning("Seerr discover/%s connection timed out", list_type)
        return []
    except Exception as e:
        logger.error("Seerr discover/%s error: %s", list_type, e)
        return []
```

- [ ] **Step 2: Commit**

```bash
cd /path/to/WebServarr
git add app/integrations/seerr.py
git commit -m "feat: add get_discover_list to seerr integration"
```

---

## Task 2: Backend — Discover Routes in `integrations.py`

**Files:**
- Modify: `app/routers/integrations.py` (append after the existing Seerr Issues block, before the Sonarr/Radarr block)

- [ ] **Step 1: Add the five routes**

In `app/routers/integrations.py`, find the comment `# --- Sonarr/Radarr Endpoints ---` and insert the following block immediately before it:

```python
# --- Seerr Discover Endpoints ---

@router.get("/seerr-discover/trending")
async def seerr_discover_trending(
    current_user: dict = Depends(get_current_user),
):
    """Get Seerr trending items (mixed movies + TV). Requires authentication."""
    return await seerr.get_discover_list("trending")


@router.get("/seerr-discover/popular-movies")
async def seerr_discover_popular_movies(
    current_user: dict = Depends(get_current_user),
):
    """Get popular movies from Seerr. Requires authentication."""
    return await seerr.get_discover_list("popular-movies")


@router.get("/seerr-discover/upcoming-movies")
async def seerr_discover_upcoming_movies(
    current_user: dict = Depends(get_current_user),
):
    """Get upcoming movies from Seerr. Requires authentication."""
    return await seerr.get_discover_list("upcoming-movies")


@router.get("/seerr-discover/popular-series")
async def seerr_discover_popular_series(
    current_user: dict = Depends(get_current_user),
):
    """Get popular TV series from Seerr. Requires authentication."""
    return await seerr.get_discover_list("popular-series")


@router.get("/seerr-discover/upcoming-series")
async def seerr_discover_upcoming_series(
    current_user: dict = Depends(get_current_user),
):
    """Get upcoming TV series from Seerr. Requires authentication."""
    return await seerr.get_discover_list("upcoming-series")
```

- [ ] **Step 2: Start the app locally and verify endpoints with curl**

```bash
# Start the app (in dev, from the WebServarr/ directory):
uvicorn app.main:app --reload

# In another terminal — log in first to get a session cookie:
curl -s -c /tmp/ws_cookies.txt -X POST http://localhost:8000/auth/simple-login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
# Expected: {"user_id": ..., "username": "admin", ...}

# Hit a discover endpoint:
curl -s -b /tmp/ws_cookies.txt http://localhost:8000/api/integrations/seerr-discover/trending | python3 -m json.tool | head -40
# Expected: JSON array. First item should have keys: id, media_type, title, year, overview, poster_url, vote_average, media_status, media_status_4k, media_info_id
# If Seerr is not running locally: expected [] (empty array), no 500 error
```

- [ ] **Step 3: Verify all 5 endpoints return arrays (not errors)**

```bash
for list in trending popular-movies upcoming-movies popular-series upcoming-series; do
  echo -n "$list: "
  curl -s -b /tmp/ws_cookies.txt http://localhost:8000/api/integrations/seerr-discover/$list | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{len(d)} items, first={d[0][\"title\"] if d else \"(empty)\"}')"
done
# Expected (with Seerr running): each line shows N items and first title
# Expected (without Seerr): each line shows 0 items
```

- [ ] **Step 4: Commit**

```bash
git add app/routers/integrations.py
git commit -m "feat: add seerr discover routes to integrations router"
```

---

## Task 3: Frontend HTML — Discover Section + Modal

**Files:**
- Modify: `app/static/requests.html`

The discover section goes **before** the stat cards (`<!-- Stat Summary Cards -->`). The modal goes **before** `</main>`. Both are static HTML shells — JS populates them at runtime.

- [ ] **Step 1: Insert discover section HTML**

In `requests.html`, find this line:

```html
<!-- Stat Summary Cards -->
```

Insert the following block immediately before it:

```html
<!-- Discover Section -->
<div id="discoverSection" class="mb-8"></div>
```

That single `<div>` is the container. JS builds the row structure inside it at page load.

- [ ] **Step 2: Insert modal HTML**

Find the closing `</main>` tag and insert the following block immediately before it:

```html
<!-- Media Detail Modal -->
<div id="mediaModal" class="fixed inset-0 z-50 hidden items-center justify-center p-4">
  <div class="absolute inset-0 bg-black/70 backdrop-blur-sm" onclick="closeMediaModal()"></div>
  <div class="relative z-10 glass-card rounded-2xl w-full max-w-lg overflow-hidden">
    <button onclick="closeMediaModal()" class="absolute top-3 right-3 z-10 text-steel-blue hover:text-frosted-blue transition-colors">
      <span class="material-symbols-outlined">close</span>
    </button>
    <div class="flex gap-4 p-5">
      <div class="w-28 shrink-0">
        <div class="aspect-[2/3] rounded-lg overflow-hidden bg-black/40 relative">
          <img id="modalPoster" src="" alt="" class="absolute inset-0 w-full h-full object-cover" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/>
          <div class="absolute inset-0 items-center justify-center poster-placeholder" style="display:none">
            <span class="material-symbols-outlined text-4xl text-steel-blue/40">movie</span>
          </div>
        </div>
      </div>
      <div class="flex-1 min-w-0 pr-6">
        <h2 id="modalTitle" class="text-frosted-blue font-bold text-lg leading-tight mb-1"></h2>
        <div class="flex items-center flex-wrap gap-2 mb-3">
          <span id="modalYear" class="text-steel-blue text-sm"></span>
          <span id="modalTypeBadge" class="text-[9px] font-bold px-1.5 py-0.5 rounded"></span>
          <span id="modalRating" class="text-[11px] text-steel-blue/80 font-medium"></span>
        </div>
        <p id="modalOverview" class="text-steel-blue/80 text-xs leading-relaxed line-clamp-4 mb-4"></p>
        <div id="modalActionArea"></div>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add app/static/requests.html
git commit -m "feat: add discover section container and media detail modal HTML"
```

---

## Task 4: Frontend CSS — Discover Rows + Scroll Buttons

**Files:**
- Modify: `app/static/requests.html` (add to the existing `<style>` block)

- [ ] **Step 1: Add CSS to the existing `<style>` block**

Find the existing `<style>` block in `requests.html` (it starts with `.filter-tab {`). Append the following rules inside it, after the `.poster-placeholder` rule:

```css
/* Discover rows */
.discover-row {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.discover-row::-webkit-scrollbar {
  display: none;
}
.discover-scroll-btn {
  position: absolute;
  top: 50%;
  transform: translateY(-60%);
  z-index: 10;
  width: 2rem;
  height: 2rem;
  border-radius: 9999px;
  background: rgb(var(--color-primary) / 0.85);
  color: rgb(var(--color-background));
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s;
  padding: 0;
}
.discover-scroll-btn:hover {
  background: rgb(var(--color-primary));
}
.discover-scroll-btn.left { left: -0.5rem; }
.discover-scroll-btn.right { right: -0.5rem; }
.discover-row-wrapper:hover .discover-scroll-btn {
  opacity: 1;
}
```

- [ ] **Step 2: Commit**

```bash
git add app/static/requests.html
git commit -m "feat: add CSS for discover row scroll buttons"
```

---

## Task 5: Frontend JS — Discover List Loading + Card Rendering

**Files:**
- Modify: `app/static/requests.html` (add to the `<script>` block)

- [ ] **Step 1: Add discover constants and helpers**

In the `<script>` block, find the `// State` comment at the top of the script. Add the discover row config immediately before it:

```javascript
// Discover row definitions
var DISCOVER_ROWS = [
  { id: 'trendingRow',       endpoint: 'trending',        label: 'Trending',        icon: 'trending_up'   },
  { id: 'popularMoviesRow',  endpoint: 'popular-movies',  label: 'Popular Movies',  icon: 'movie'         },
  { id: 'upcomingMoviesRow', endpoint: 'upcoming-movies', label: 'Upcoming Movies', icon: 'upcoming'      },
  { id: 'popularSeriesRow',  endpoint: 'popular-series',  label: 'Popular Series',  icon: 'live_tv'       },
  { id: 'upcomingSeriesRow', endpoint: 'upcoming-series', label: 'Upcoming Series', icon: 'calendar_month'},
];
```

- [ ] **Step 2: Add `loadDiscoverLists` and row-building functions**

Find the comment `// ---- Search ----` and insert the following block immediately before it:

```javascript
// ---- Discover Lists ----

function buildDiscoverSection() {
  var section = document.getElementById('discoverSection');
  if (!section) return;
  DISCOVER_ROWS.forEach(function(row) {
    var html =
      '<div class="mb-6">' +
        '<div class="flex items-center gap-2 mb-3">' +
          '<span class="material-symbols-outlined text-primary text-xl">' + row.icon + '</span>' +
          '<h2 class="text-sm font-bold text-frosted-blue uppercase tracking-wider">' + escapeHtml(row.label) + '</h2>' +
        '</div>' +
        '<div class="discover-row-wrapper relative">' +
          '<button onclick="scrollDiscoverRow(\'' + row.id + '\', -1)" class="discover-scroll-btn left">' +
            '<span class="material-symbols-outlined text-sm">chevron_left</span>' +
          '</button>' +
          '<div id="' + row.id + '" class="discover-row flex gap-3 overflow-x-auto scroll-smooth pb-2">' +
            buildDiscoverSkeletons() +
          '</div>' +
          '<button onclick="scrollDiscoverRow(\'' + row.id + '\', 1)" class="discover-scroll-btn right">' +
            '<span class="material-symbols-outlined text-sm">chevron_right</span>' +
          '</button>' +
        '</div>' +
      '</div>';
    section.insertAdjacentHTML('beforeend', html);
  });
}

function buildDiscoverSkeletons() {
  var html = '';
  for (var i = 0; i < 8; i++) {
    html +=
      '<div class="shrink-0 w-28 rounded-xl overflow-hidden animate-pulse">' +
        '<div class="aspect-[2/3] bg-steel-blue/10 rounded-xl"></div>' +
        '<div class="py-1.5 px-1"><div class="h-2.5 bg-steel-blue/10 rounded w-3/4 mt-1"></div></div>' +
      '</div>';
  }
  return html;
}

async function loadDiscoverLists() {
  buildDiscoverSection();
  DISCOVER_ROWS.forEach(function(row) {
    fetch('/api/integrations/seerr-discover/' + row.endpoint)
      .then(function(resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function(items) {
        renderDiscoverRow(row.id, items);
      })
      .catch(function(err) {
        console.warn('Discover list ' + row.endpoint + ' failed:', err);
        renderDiscoverRowError(row.id);
      });
  });
}

function renderDiscoverRow(rowId, items) {
  var row = document.getElementById(rowId);
  if (!row) return;
  if (!items || items.length === 0) {
    row.innerHTML = '<p class="text-steel-blue/50 text-xs py-4 px-2 italic">Nothing to show</p>';
    return;
  }
  row.textContent = '';
  var fragment = document.createDocumentFragment();
  items.forEach(function(item) {
    var wrapper = document.createElement('div');
    wrapper.insertAdjacentHTML('beforeend', buildDiscoverCard(item));
    var card = wrapper.firstChild;
    // Store item data directly on the element for the modal (avoids a lookup table)
    card._discoverItem = item;
    card.addEventListener('click', function() { openMediaModal(this._discoverItem); });
    fragment.appendChild(card);
  });
  row.appendChild(fragment);
  wirePosterFallbacks(row);
}

function renderDiscoverRowError(rowId) {
  var row = document.getElementById(rowId);
  if (row) row.innerHTML = '<p class="text-steel-blue/50 text-xs py-4 px-2 italic">Could not load</p>';
}

function buildDiscoverCard(item) {
  var title = escapeHtml(item.title || 'Unknown');
  var mediaType = item.media_type || 'movie';
  var typeBadge = mediaType === 'tv' ? 'TV' : 'Movie';
  var typeBadgeColor = mediaType === 'tv' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400';
  var posterUrl = item.poster_url || '';
  var status = item.media_status ? item.media_status.toLowerCase() : null;

  // Colored dot overlay indicating request/availability status
  var dotHtml = '';
  if (status) {
    var dotColor = 'bg-steel-blue';
    if (status === 'available') dotColor = 'bg-green-500';
    else if (status === 'processing' || status === 'approved') dotColor = 'bg-blue-500';
    else if (status === 'partially_available') dotColor = 'bg-yellow-500';
    dotHtml = '<div class="absolute top-2 left-2 w-2.5 h-2.5 rounded-full ' + dotColor + ' ring-2 ring-black/60"></div>';
  }

  var posterHtml;
  if (posterUrl) {
    posterHtml =
      '<img src="' + escapeHtml(posterUrl) + '" alt="' + title + '" ' +
        'class="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" ' +
        'onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'"/>' +
      '<div class="absolute inset-0 items-center justify-center poster-placeholder" style="display:none">' +
        '<span class="material-symbols-outlined text-3xl text-steel-blue/40">movie</span>' +
      '</div>';
  } else {
    posterHtml =
      '<div class="absolute inset-0 flex items-center justify-center poster-placeholder">' +
        '<span class="material-symbols-outlined text-3xl text-steel-blue/40">movie</span>' +
      '</div>';
  }

  return (
    '<div class="shrink-0 w-28 rounded-xl overflow-hidden glass-card cursor-pointer group">' +
      '<div class="aspect-[2/3] relative overflow-hidden">' +
        posterHtml +
        '<div class="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent"></div>' +
        '<div class="absolute top-2 right-2">' +
          '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded ' + typeBadgeColor + '">' + typeBadge + '</span>' +
        '</div>' +
        dotHtml +
      '</div>' +
      '<div class="p-1.5">' +
        '<p class="text-frosted-blue text-[11px] font-medium leading-tight truncate">' + title + '</p>' +
      '</div>' +
    '</div>'
  );
}

function scrollDiscoverRow(rowId, direction) {
  var row = document.getElementById(rowId);
  if (row) row.scrollBy({ left: direction * 400, behavior: 'smooth' });
}
```

- [ ] **Step 3: Wire `loadDiscoverLists()` into `DOMContentLoaded`**

In the `DOMContentLoaded` handler, find the line:

```javascript
    // Load initial data
    loadRequestCounts();
    loadExistingRequests();
```

Add `loadDiscoverLists();` on the line immediately before `loadRequestCounts()`:

```javascript
    // Load initial data
    loadDiscoverLists();
    loadRequestCounts();
    loadExistingRequests();
```

- [ ] **Step 4: Commit**

```bash
git add app/static/requests.html
git commit -m "feat: add discover list loading and card rendering JS"
```

---

## Task 6: Frontend JS — Media Detail Modal

**Files:**
- Modify: `app/static/requests.html` (add to the `<script>` block)

- [ ] **Step 1: Add modal functions**

Find the comment `// ---- Toast Notifications ----` and insert the following block immediately before it:

```javascript
// ---- Media Detail Modal ----

function openMediaModal(item) {
  var modal = document.getElementById('mediaModal');
  var mediaType = item.media_type || 'movie';
  var status = item.media_status ? item.media_status.toLowerCase() : null;

  // Poster — reset error fallback state each time
  var poster = document.getElementById('modalPoster');
  poster.style.display = '';
  if (poster.nextElementSibling) poster.nextElementSibling.style.display = 'none';
  poster.src = item.poster_url || '';
  poster.alt = item.title || '';

  // Text content
  document.getElementById('modalTitle').textContent = item.title || 'Unknown';
  document.getElementById('modalYear').textContent = item.year || '';
  document.getElementById('modalOverview').textContent = item.overview || 'No description available.';

  // Type badge
  var typeBadge = document.getElementById('modalTypeBadge');
  if (mediaType === 'tv') {
    typeBadge.textContent = 'TV Series';
    typeBadge.className = 'text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400';
  } else {
    typeBadge.textContent = 'Movie';
    typeBadge.className = 'text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400';
  }

  // Rating
  var ratingEl = document.getElementById('modalRating');
  ratingEl.textContent = (item.vote_average && item.vote_average > 0)
    ? '\u2605 ' + item.vote_average.toFixed(1)
    : '';

  // Action area: Request button or status badge
  var actionArea = document.getElementById('modalActionArea');
  if (!status) {
    actionArea.innerHTML =
      '<button id="modalRequestBtn" ' +
        'data-media-type="' + escapeHtml(mediaType) + '" ' +
        'data-media-id="' + item.id + '" ' +
        'onclick="requestFromModal(this)" ' +
        'class="w-full py-2 rounded-lg bg-primary hover:bg-primary/80 text-bright text-xs font-bold transition-all">' +
        'Request' +
      '</button>';
  } else {
    actionArea.innerHTML =
      '<div class="w-full py-2 flex items-center justify-center">' +
        getStatusBadge(status) +
      '</div>';
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeMediaModal() {
  var modal = document.getElementById('mediaModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  // Clear action area to prevent stale button state on next open
  document.getElementById('modalActionArea').innerHTML = '';
}

function requestFromModal(buttonEl) {
  var mediaType = buttonEl.getAttribute('data-media-type');
  var mediaId = parseInt(buttonEl.getAttribute('data-media-id'), 10);
  // Reuse existing requestMedia — passes buttonEl so its built-in
  // spinner/success/error handling works inside the modal action area.
  requestMedia(mediaType, mediaId, false, buttonEl);
}
```

- [ ] **Step 2: Add Escape key listener to close modal**

Find the `DOMContentLoaded` handler. After the scroll-down hint setup block (the `(function() { var hint = ...})();` IIFE), add:

```javascript
    // Close media modal on Escape key
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') closeMediaModal();
    });
```

- [ ] **Step 3: Commit**

```bash
git add app/static/requests.html
git commit -m "feat: add media detail modal open/close/request JS"
```

---

## Task 7: End-to-End Verification

No automated tests exist in this project. Verify manually using the app.

- [ ] **Step 1: Start the app and log in**

```bash
uvicorn app.main:app --reload
# Navigate to http://localhost:8000/requests in a browser
```

- [ ] **Step 2: Check discover rows appear**

Expected: Five horizontal-scroll rows appear above the stat cards. Each shows poster cards with type badges. If Seerr is configured, real posters load. If not, each row shows "Nothing to show".

- [ ] **Step 3: Check scroll buttons**

Hover over a row. Left/right chevron buttons should fade in. Click right arrow — row scrolls smoothly by ~400px. Click left — scrolls back.

- [ ] **Step 4: Check modal opens**

Click any discover poster card. Modal should:
- Appear with backdrop blur
- Show the poster, title, year, type badge, star rating, overview
- Show a "Request" button if item is not yet in Seerr, or a status badge if it is

- [ ] **Step 5: Check modal request flow**

Click "Request" in the modal. Button should:
- Show spinner while submitting
- Replace with "Pending" badge on success
- Show a green toast "Request submitted successfully!"
- NOT close the modal (stays open showing the new status)

- [ ] **Step 6: Check Escape key and backdrop close**

Press Escape — modal closes. Click the dark backdrop — modal closes. ✕ button — modal closes.

- [ ] **Step 7: Check search cards are unchanged**

Search for a title in the search box. Cards should still show the inline "Request" button — NOT be click-to-modal.

- [ ] **Step 8: Check console for errors**

Open browser devtools → Console. Should be no errors during normal use.

- [ ] **Step 9: Tag and push**

```bash
# Check latest tag
git tag --sort=-v:refname | head -1
# Expected: v1.2.4

# This is a batch of 5+ meaningful changes, so bump MINOR
git tag v1.3.0
git push && git push --tags
```

- [ ] **Step 10: Wait for CI and deploy**

```bash
gh run watch --exit-status
# Then deploy:
ssh webserver "cd ~/webservarr && docker compose pull && docker compose up -d"
```
