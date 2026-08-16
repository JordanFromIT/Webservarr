# WebServarr Ebook Reader — Design

**Date:** 2026-08-14
**Status:** Approved for planning
**Target release:** v1.5.0
**Phase:** 15 — Ebook Reader

> This design supersedes an earlier draft that proposed a Kavita service account, client-side
> EPUB rendering with foliate-js, and WebServarr owning reading state. Live investigation on
> 2026-08-14 disproved all three. What follows reflects what was actually verified against a
> running Kavita 0.9.0.2 and the production Authentik.

---

## 1. Summary

Kavita is the ebook **backend**. WebServarr is its **front-end**. That is the whole design.

Kavita owns the library and all per-user reading state — progress, bookmarks, highlights,
notes, shelves, stats. WebServarr owns the entire user experience: a custom, fully themed
reader and library built into hmserver.tv, with no Kavita UI ever shown to a user.

Users are the same people in both systems, via Authentik OIDC. Kavita runs on mediaserver,
reachable only over WireGuard. WebServarr proxies it, so the browser only ever talks to
`hmserver.tv`.

### Why WebServarr does not own reading state

Kavita already implements per-user progress, bookmarks, want-to-read, highlights with five
colour slots, notes, annotation sharing, Obsidian export, and reading statistics — all
verified present in its API. Rebuilding those inside WebServarr would mean five new tables
and five new subsystems duplicating maintained upstream software, and would make WebServarr's
largest subsystem an ebook backend rather than a portal.

### Why Kavita is not shown to users directly

Kavita emits **no CORS headers and has no setting to add them** (verified: no CORS keys in
its settings API, no headers on any response, nothing in `appsettings.json`). A browser on
`hmserver.tv` therefore cannot call Kavita on another origin. Proxying is not a preference —
it is the only mechanism that works.

---

## 2. Verified facts

Everything below was tested live on 2026-08-14, not inferred.

| Fact | Evidence |
|---|---|
| VPS reaches mediaserver over WireGuard | `ping` 23ms via `wg0`; Kavita HTTP 200 in 83ms |
| Kavita reaches Authentik | discovery doc fetched, HTTP 200 |
| Silent SSO works end to end | logged-in WebServarr user hit Kavita's OIDC login and landed authenticated with **no prompt and no consent screen** |
| Auto-provisioning works | Kavita log: `Creating new user from OIDC`, then `Assigning defaults; Roles: ["Login","Download"], Libraries: [1]` |
| Identity is shared | Kavita stores Authentik's `hashed_user_id` subject — the same subject WebServarr uses |
| Kavita has no CORS support | no settings, no headers, nothing in config |
| Kavita derives `redirect_uri` from the Host header | sending `Host: books.hmserver.tv` produced exactly that redirect URI |
| Library scans correctly | 93 files → 79 series |
| Every required feature exists in the API | annotations, bookmarks, progress, shelves, stats — full CRUD (§5) |

---

## 3. Architecture

```
Browser (hmserver.tv)              VPS 10.30.0.2                mediaserver 10.10.0.3
┌────────────────────┐  https   ┌──────────────────────┐  WG   ┌──────────────────────┐
│ library.html       │─────────▶│ WebServarr           │──────▶│ Kavita :5000         │
│ reader.html        │          │  /kavita/*  (proxy)  │ http  │  library + ALL       │
│  (WebServarr's own │◀─────────│  /signin-oidc        │◀──────│  per-user state      │
│   themed UI)       │          │  strips prefix       │       └──────────────────────┘
└────────────────────┘          └──────────────────────┘                 │ read-only
                                                              /mnt/mediapool/library/eBooks
                                                                         ▲ writes
                                                                    ┌──────────┐
                                                                    │ Chaptarr │
                                                                    └──────────┘
```

**Kavita is not publicly exposed.** No subdomain, no tunnel route. It is reachable only from
the VPS across WireGuard.

**No mixed-content problem.** The browser only ever loads `https://hmserver.tv`. The plain
HTTP hop is server-side over WireGuard — identical to the six integrations WebServarr already
proxies today (Plex, Seerr, Netdata, Sonarr, Radarr, Uptime Kuma, all `http://`).

### Component responsibilities

| Component | Owns |
|---|---|
| Chaptarr | Acquisition, organisation, naming. Writes the library. |
| Kavita | Scanning, metadata, covers, search, file serving, **and all per-user reading state**. |
| WebServarr | The entire user experience, and proxying. Stores no ebook data. |
| Authentik | Identity for both, via OIDC. |

### Proxy routes

| Browser path | Proxied to | Notes |
|---|---|---|
| `/kavita/api/*` | `http://10.10.0.3:5000/api/*` | prefix stripped |
| `/kavita/oidc/login` | `.../oidc/login` | starts the handshake |
| `/signin-oidc` | `.../signin-oidc` | must live at root — Kavita builds this URI from the Host header without knowledge of our prefix |

Kavita's `baseUrl` stays `/`. It only matters for Kavita's own Angular app, which we never
serve — we consume the API and replace the UI entirely.

### Authentik

An application and provider already exist (created 2026-08-14): client type confidential,
`default-provider-authorization-implicit-consent` (**no consent prompt** — this is what makes
login silent), `sub_mode` hashed user ID matching WebServarr, scopes `openid profile email`,
PKCE S256.

**Change required:** the registered redirect URI must become
`https://hmserver.tv/signin-oidc`. The existing `https://books.hmserver.tv/signin-oidc` should
be removed when the subdomain is retired.

---

## 4. Authentication flow

1. User is already signed into WebServarr via Authentik.
2. WebServarr needs a Kavita session for that user, so the browser hits
   `/kavita/oidc/login`.
3. WebServarr proxies to Kavita, which redirects to Authentik.
4. Authentik recognises the existing session and returns immediately — **no prompt, no
   consent** (verified).
5. The browser posts back to `/signin-oidc`, proxied to Kavita, which creates the account on
   first visit and issues its JWT.
6. WebServarr holds that JWT for the user's session and attaches it to proxied API calls.

Because everything is same-origin, there is no CORS anywhere in this flow.

⚠️ **Cold-start gap.** A user with *no* Authentik session who somehow triggers this flow gets
Authentik's `default-authentication-flow`, which shows a username/password box and no Plex
option — unusable for Plex-only users. In the normal path this never happens, because users
reach the reader from inside an authenticated WebServarr session. The reader must therefore
**never** initiate the Kavita handshake for an unauthenticated visitor; it redirects to
WebServarr's own login first.

---

## 5. Feature surface

All verified present in Kavita's API. Nothing here requires a fork.

| Capability | Endpoints |
|---|---|
| Catalog | `series/all-v2`, `series/series-detail`, `series/volumes`, `series/metadata`, `series/recently-added-v2`, `series/on-deck`, `series/currently-reading` |
| Search | `search/*` |
| Reading | `book/{chapterId}/book-page?page=N`, `book/{chapterId}/book-info`, `reader/chapter-info`, `reader/create-ptoc` |
| Progress | `reader/get-progress`, `has-progress`, `continue-point`, `mark-chapter-read` |
| Bookmarks | `reader/bookmark`, `all-bookmarks`, `chapter-bookmarks`, `bulk-remove-bookmarks` |
| Annotations | `annotation/create`, `update`, `bulk-delete`, `all`, `all-for-series`, `all-filtered`, `export`, `like` |
| Shelves | `want-to-read` add/remove |
| Stats | `stats/reading-counts`, `pages-per-year`, `words-per-year`, `day-breakdown`, `popular-genres`, `popular-series` |
| Covers | `image/series-cover` |

### The rendering constraint — important

**Kavita's book model is server-paginated.** Its reader fetches
`book/{chapterId}/book-page?page=N`, where Kavita parses the EPUB server-side and returns
rendered HTML for that page. Critically:

- progress is `saveProgress(libraryId, seriesId, volumeId, chapterId, **pageNumber**)`
- annotations are `{comment, **pageNumber**, selectedText}`

Both anchor to Kavita's page numbers. **The reader must therefore render Kavita's HTML pages,
not parse the EPUB client-side.** A client-side renderer would have its own coordinate system,
and every highlight and reading position would point somewhere Kavita cannot resolve —
destroying the interoperability that justifies this architecture.

foliate-js is consequently **not** used.

What this costs and what it does not:

- ✅ WebServarr controls 100% of styling — typography, fonts, sizes, spacing, colours, layout
- ✅ WebServarr controls all chrome, controls, navigation, animation, keyboard and touch
- ✅ Highlights, notes, progress and shelves interoperate exactly with Kavita
- ⚠️ Page boundaries are Kavita's server-side chunks. Within a page we control scrolling and
  columns; we do not control where chunks break

---

## 6. What WebServarr builds

**Backend**

| File | Purpose |
|---|---|
| `app/routers/kavita_proxy.py` | **new** — the proxy: `/kavita/*` and `/signin-oidc`, prefix stripping, per-user JWT attachment, streaming for page and image responses |
| `app/integrations/kavita.py` | **new** — thin helpers for the OIDC handshake and JWT lifecycle |
| `app/main.py` | **modified** — register router; narrow CSP change if required by the reader |
| `app/routers/admin.py` | **modified** — Kavita URL setting (`integration.kavita.url`, which the existing `is_safe_integration_url` guard validates automatically and which permits LAN) plus test-connection |

**No new database tables.** WebServarr stores no ebook data. The user's Kavita JWT lives in
their existing Redis session.

**Frontend**

| File | Purpose |
|---|---|
| `app/static/library.html` | **new** — browse, search, continue-reading, shelves |
| `app/static/reader.html` | **new** — the reader: renders Kavita page HTML, styled entirely by us |

Both pages go through WebServarr's theming engine — `theme-loader.js` in `<head>` before
Tailwind, the Tailwind alias block from `index.html:16–25` mapping class names onto
`--color-*` custom properties. **No hardcoded brand hexes**, so an admin recolouring the site
from the Customization tab moves these pages too. `brand-assets/` remains the reference for
layout and composition, never copied into the page as literal values.

Book content is styled from `--hex-background` / `--hex-text` so it opens matching the site,
with the reader's own light/dark/sepia control able to override — readers legitimately want
sepia regardless of site branding.

Navigation follows the existing `features.show_books` / `sidebar_labels` / `icons` pattern.

---

## 7. Scope

**v1.5.0** — proxy, auth handoff, library browse and search, the reader with full typography
and theming controls, table of contents, progress, and bookmarks.

**v1.6.0** — annotations: highlights, notes, panel, export.

**v1.7.0** — shelves, reading stats, advanced browse and filter.

Phasing is deliberate: v1.5.0 is a complete, usable reader, and reaching it sooner beats one
long branch. Each release ships working software.

**Out of scope entirely:** book requests (nothing off-the-shelf exists), audiobooks (handled
via Plex in the mediaserver workstream), and any Chaptarr→Kavita metadata pipeline unless §9
measurement justifies it.

---

## 8. Security

| Concern | Handling |
|---|---|
| Kavita exposure | None. LAN-only, no tunnel route, reachable only from the VPS. |
| Per-user isolation | Enforced by Kavita, keyed to the OIDC subject. WebServarr never merges users. |
| Proxy auth | Every `/kavita/*` route requires `Depends(get_current_user)`. No anonymous proxying — the proxy must never become an open relay to the LAN. |
| SSRF | Existing `is_safe_integration_url` via the `integration.*.url` key convention; permits LAN, blocks loopback/link-local/metadata. |
| Rate limiting | Existing slowapi tiers; a tighter dedicated tier for page and file fetches. |
| Secrets | Kavita URL in settings; the per-user JWT in Redis session only, never sent to the browser as a durable credential. |

✅ **Kavita's `TokenKey` has been rotated** (2026-08-16). It lives in
`/kavita/config/appsettings.json` — note that the OIDC settings beside it are read from
`ServerSetting` key 40 in Kavita's database instead, so editing them in the file does nothing.

---

## 9. Known data issues

- **`Michael Crichton/Travels/Travels.epub` is unreadable.** Kavita logs *"Unable to parse any
  meaningful information"*. That is why 94 files yield 93. Needs re-acquiring.
- **16 MOBI/AZW3 files are invisible to Kavita**, which catalogs EPUB and PDF only — roughly
  15% of the library, including the GRRM omnibus. Fix is a one-time Calibre conversion writing
  `.epub` alongside the originals: back up first, convert in staging outside the library root,
  validate every output opens with a title, then place. Originals are never modified or
  deleted; rollback is deleting the added files.
- **Several books required lenient metadata parsing** (A Feast for Crows, Brothers of the
  Snake, others). Titles that did scan look clean. A read-only OPF audit across all EPUBs
  should run before the library UI is considered done; if the suspect rate is under ~10%, fix
  those by hand in Kavita and build no pipeline.

---

## 10. Verification

This repository has no automated test suite — no `tests/`, no pytest. Fourteen phases shipped
verified against the running application, and this follows that practice rather than
introducing a test framework as a rider on a feature.

Required checks:

1. Every `/kavita/*` route returns 401 unauthenticated.
2. Two different users see their own progress and highlights, never each other's.
3. The proxy streams page and image responses rather than buffering.
4. Reading position set in the WebServarr reader is visible in Kavita's own UI for the same
   user — proof the interoperability is real.
5. No CSP violations in the console; no mixed-content warnings.
6. Stopping Kavita degrades the library page to a clear unavailable state, never a spinner,
   and leaves the rest of WebServarr working.
7. `/health` reports 1.5.0; existing integrations still 200; the v1.4.2 login auth-reveal
   behaviour is unchanged.

Check 4 is the one that proves the architecture; it must not be skipped.

---

## 11. Release

Ships as **v1.5.0** (current tag `v1.4.2`). Standard flow: edit locally → commit → push → tag
→ GitHub Actions builds the GHCR image → watchtower deploys `:latest`.
