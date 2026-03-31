# Discover Lists + Detail Modal — Design Spec

**Date:** 2026-03-31
**Status:** Approved

---

## Overview

Add five Seerr "Discover" list rows (Trending, Popular Movies, Upcoming Movies, Popular Series, Upcoming Series) to `requests.html`, displayed above the existing stat cards and search/requests columns. Each discover card opens a detail/request modal when clicked. Search cards retain their existing inline Request button behavior unchanged.

---

## Backend

### `app/integrations/seerr.py`

Add one new function:

```python
async def get_discover_list(list_type: str, page: int = 1) -> list
```

**List type → Seerr endpoint mapping:**

| `list_type`        | Seerr endpoint                        |
|--------------------|---------------------------------------|
| `trending`         | `GET /api/v1/discover/trending`       |
| `popular-movies`   | `GET /api/v1/discover/movies`         |
| `upcoming-movies`  | `GET /api/v1/discover/movies/upcoming`|
| `popular-series`   | `GET /api/v1/discover/tv`             |
| `upcoming-series`  | `GET /api/v1/discover/tv/upcoming`    |

**Normalization:** Each result is normalized to the same shape as `search_media` results:

```python
{
    "id": int,           # TMDB ID
    "media_type": str,   # "movie" or "tv"
    "title": str,
    "year": str,
    "overview": str,
    "poster_url": str,   # full TMDB image URL (w300)
    "vote_average": float,
    "media_status": str | None,    # from mediaInfo.status, using MEDIA_STATUS_MAP
    "media_status_4k": str | None, # from mediaInfo.status4k
    "media_info_id": int | None,
}
```

Returns an empty list on Seerr config missing, HTTP error, or timeout. Filters results to `media_type` of `"movie"` or `"tv"` only.

### `app/routers/integrations.py`

Add five new authenticated GET routes, all requiring `get_current_user`:

```
GET /api/integrations/seerr-discover/trending
GET /api/integrations/seerr-discover/popular-movies
GET /api/integrations/seerr-discover/upcoming-movies
GET /api/integrations/seerr-discover/popular-series
GET /api/integrations/seerr-discover/upcoming-series
```

Each route calls `seerr.get_discover_list("<list_type>")` and returns the normalized list directly.

---

## Frontend

### Discover Section

**Placement:** Inserted above the stat cards (top of the scrollable content area).

**Structure:** Five horizontal-scroll rows. Each row:
- Section heading with a Material icon and label
- Relative container holding left/right scroll arrow buttons and the scrollable strip
- Strip uses `overflow-x-auto`, `scroll-smooth`, hidden scrollbar (`no-scrollbar` utility or `scrollbar-hide`)
- Left/right buttons call `scrollDiscoverRow(rowEl, direction)` to scroll by ~400px

**Icons per row:**

| Row | Icon |
|-----|------|
| Trending | `trending_up` |
| Popular Movies | `movie` |
| Upcoming Movies | `upcoming` |
| Popular Series | `live_tv` |
| Upcoming Series | `calendar_month` |

**Discover cards** are ~120px wide, fixed, with a 2:3 aspect poster. They show:
- Poster image (with fallback placeholder)
- MOVIE/SERIES type badge (top-right, same color scheme as search cards)
- Status indicator: small colored dot top-left if `media_status` is non-null (green = available, blue = processing/pending, yellow = partial)
- One-line truncated title below the poster

Clicking anywhere on the card calls `openMediaModal(item)`. No inline Request button.

**Loading state:** Each row shows a row of skeleton placeholder cards (same size, pulsing opacity) while fetching.

**Error/empty state:** A single line of muted text in the row ("Could not load" or "Nothing to show") — does not affect other rows.

### Detail/Request Modal

**HTML:** A single modal overlay added once to the page. Hidden by default (`hidden` class).

**Layout:**
```
[ backdrop (click to close) ]
┌─────────────────────────────────────┐
│  [poster 112px]  [✕]               │
│                  Title              │
│                  Year · Badge · ★   │
│                  Overview (4 lines) │
│                  [Request / Status] │
└─────────────────────────────────────┘
```

- Backdrop: `fixed inset-0 bg-black/70 backdrop-blur-sm`, click closes modal
- Card: `glass-card rounded-2xl max-w-lg w-full`, centered with flex
- Poster: 112px wide, 2:3 aspect, rounded-lg, same fallback logic as cards
- ✕ button: top-right of the card (not the backdrop)
- Title: `text-frosted-blue font-bold text-lg`
- Year + type badge + star rating on one line
- Overview: `text-steel-blue/80 text-xs leading-relaxed line-clamp-4`
- Action area (`#modalActionArea`): contains either:
  - A "Request" button → calls `requestFromModal()` which calls existing `requestMedia()` logic
  - Or the appropriate status badge if `media_status` is already set

**`openMediaModal(item)`:** Populates all modal fields from the in-memory `item` object (no API call). Shows the modal.

**`closeMediaModal()`:** Hides the modal, clears `#modalActionArea` to prevent stale state.

**`requestFromModal()`:** Reads `mediaType` and `mediaId` stored as `data-` attributes on the modal's Request button, then calls `requestMedia(mediaType, mediaId, false, buttonEl)` directly — passing the modal button as `buttonEl`. This reuses the existing function's spinner, success (replaces button with status badge, shows toast, refreshes requests), and error (re-enables button, shows error toast) handling without duplication.

### JS Functions Added

| Function | Purpose |
|---|---|
| `loadDiscoverLists()` | Fires 5 parallel fetches on page load, renders each row |
| `renderDiscoverRow(rowId, items)` | Renders cards into a specific row element |
| `buildDiscoverCard(item)` | Returns HTML string for a single discover card |
| `scrollDiscoverRow(rowEl, dir)` | Scrolls a row element left or right by 400px |
| `openMediaModal(item)` | Populates and shows the detail modal |
| `closeMediaModal()` | Hides and resets the modal |
| `requestFromModal()` | Submits a request from within the modal |

### Existing Code Unchanged

- `buildSearchCard()` — no changes, inline Request button stays
- `requestMedia()` — no changes, still used by both search cards and `requestFromModal()`
- `loadExistingRequests()`, `renderRequests()`, stats cards — unchanged

---

## Data Flow

```
DOMContentLoaded
  └─ loadDiscoverLists()
       ├─ fetch /seerr-discover/trending          ─┐
       ├─ fetch /seerr-discover/popular-movies      │ parallel
       ├─ fetch /seerr-discover/upcoming-movies     │
       ├─ fetch /seerr-discover/popular-series      │
       └─ fetch /seerr-discover/upcoming-series    ─┘
            └─ each: renderDiscoverRow(rowId, items)
                       └─ buildDiscoverCard(item) × N

User clicks discover card
  └─ openMediaModal(item)
       └─ populate modal from item (no fetch)
            └─ user clicks "Request"
                 └─ requestFromModal()
                      └─ POST /api/integrations/seerr-request
                           └─ success: update modal → "Pending" badge + toast
```

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Seerr not configured | `get_discover_list` returns `[]`; row shows empty state message |
| Seerr HTTP error / timeout | Same — empty list, row shows error message |
| One row fails | Other rows unaffected (independent fetches) |
| Poster image 404 | Inline `onerror` fallback to placeholder icon (same as existing cards) |
| Request already exists | Seerr returns error; toast shows Seerr's error message |

---

## Out of Scope

- Pagination within discover rows (show first page / ~20 items only)
- Refresh button or auto-refresh for discover lists
- Clicking existing "Your Requests" cards to open modal
- Genre/studio/network rows
- 4K request option in modal
