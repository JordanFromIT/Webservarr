# Login Page Rotating Backgrounds — Design

**Date:** 2026-02-26
**Drawbridge task:** #52
**Status:** Approved

## Summary

Replace the static stock image grid on the login page with a fullscreen crossfade slideshow of TMDB trending movie/TV backdrop images, sourced via the existing Overseerr integration. Falls back to the current static grid when Overseerr is unavailable.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Image type | Fanart/backgrounds (wide cinematic backdrops) | Best for fullscreen backgrounds |
| Transition | Crossfade slideshow (1.5s fade, ~10s interval) | Clean, cinematic, low CPU |
| Image source | TMDB trending via Overseerr `/api/v1/backdrops` | Reuses existing integration, no new API keys |
| Auth model | Public endpoint (no auth) | Login page is pre-auth; only image URLs exposed |
| Fallback | Static poster grid (current design) | Always works, even without Overseerr |

## Backend

### New function: `overseerr.get_backdrops(db)`

In `app/integrations/overseerr.py`:
- Calls `GET {overseerr_url}/api/v1/backdrops` with existing API key
- Returns list of full TMDB URLs: `https://image.tmdb.org/t/p/original/{path}`
- Returns `[]` on error or if Overseerr is not configured

### New endpoint: `GET /api/integrations/backgrounds`

In `app/routers/integrations.py`:
- No auth required (login page loads pre-authentication)
- Calls `overseerr.get_backdrops(db)`
- Returns JSON array of image URL strings
- Returns `[]` if Overseerr is unavailable

### New setting: `features.login_backgrounds`

- Default: `true`
- When `true` and Overseerr configured: fetch TMDB backgrounds
- When `false`: always show static grid
- Exposed via `GET /api/branding` → `features.login_backgrounds`
- Seeded in `app/seed.py`

## Frontend (`login.html`)

### Slideshow mechanism

1. On DOMContentLoaded, fetch `GET /api/integrations/backgrounds`
2. If empty or error → keep static poster grid, done
3. If images returned:
   - Hide static poster grid
   - Create two stacked fullscreen `<div>` elements (position absolute, inset 0)
   - Load first image into div A (opacity 1), preload second image
   - Every ~10 seconds: load next image into hidden div, crossfade (CSS transition: opacity 1.5s)
   - Alternate between div A and div B
   - Dark overlay (`cinematic-overlay`) remains on top of both

### Preloading

- Use `new Image()` to preload the next backdrop before transitioning
- On load complete, swap the background and trigger the opacity transition
- If preload fails, skip to the next image

### CSS

```css
.backdrop-slide {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  transition: opacity 1.5s ease-in-out;
}
```

### Fallback behavior

- Static grid HTML stays in the DOM
- JS hides it (`display: none`) only when TMDB images are successfully loaded
- If fetch fails or returns empty, static grid remains visible
- `features.login_backgrounds === false` in branding → skip fetch entirely

## CSP

`image.tmdb.org` is already allowed via CSP `img-src` (used throughout for Overseerr poster images). No CSP changes needed.

## No new dependencies

All implemented with existing libraries (httpx for backend, vanilla JS for frontend).
