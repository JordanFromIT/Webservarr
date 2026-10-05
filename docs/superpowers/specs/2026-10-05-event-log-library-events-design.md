# Event log: library events from Sonarr, Radarr and Chaptarr

This is part of v2 roadmap step 5, Home. Status: designed with Jordan on 2026-10-05 in chat. It extends the
status feed (`2026-10-04-home-redesign-and-status-feed-design.md`, section 3) and the Home "Event log"
(commit a5508d9). The data spike behind it is
`.superpowers/sdd/2026-10-05-event-log-sources/spike.md`.

## 1. Goal

The event log on Home shows what is happening on the server. Besides outages and admin notes, it should
show library activity in plain words for non-technical users: a request being downloaded, arriving,
being upgraded, being dropped. Each line must read so a family member can't mistake it. For example,
"monitored" never reads as "available".

## 2. Decisions (Jordan)

- **Sources:** webhooks from Sonarr, Radarr and Chaptarr. There is no Plex check in WebServarr; Plex
  reachability stays in Uptime Kuma (section 8).
- **Format:** `<Action>: <Title>`. The plain-English action comes first, in Title Case.
- **Who sees it:** everyone signed in. It shows titles only, never who requested them.
- **Push notifications:** none for library lines.
- **Health events:** health issues and health restored are dropped.
- **Grab lines** carry a short muted note, " · not guaranteed", because a grab can fail. None of the
  apps sends a "download failed" webhook. A failed grab therefore leaves its line with no "Added"
  after it, which is accepted.
- **Timing:** a line posts when the webhook arrives. There's no wait for Plex.

## 3. Translation table

Keyed by the trigger names in each app's UI. Anything not listed produces no line: no error, a 204
response. Test pings also produce no line.

### Radarr

| Trigger (UI) | `eventType` | Condition | Event log line |
|---|---|---|---|
| On Grab | `Grab` | | `Movie Downloading: Dune (2021) · not guaranteed` |
| On File Import | `Download` | `isUpgrade` false | `Movie Added: Dune (2021)` |
| On File Upgrade | `Download` | `isUpgrade` true | `Movie Upgraded: Dune (2021), now 4K` |
| On Movie Added | `MovieAdded` | | `Movie Monitored: Dune Messiah (2026)` |
| On Movie Delete | `MovieDelete` | `deletedFiles` false | `Movie Unmonitored: Dune (2021)` |
| On Movie Delete | `MovieDelete` | `deletedFiles` true | `Movie Removed: Dune (2021)` |
| On Movie File Delete | `MovieFileDelete` | `deleteReason` is not `upgrade` | `Movie Removed: Dune (2021)` |
| On Movie File Delete | `MovieFileDelete` | `deleteReason` is `upgrade` | none |
| On Movie File Delete For Upgrade, On Rename, On Health Issue/Restored, On Application Update, On Manual Interaction Required | | | none |

### Sonarr

| Trigger (UI) | `eventType` | Condition | Event log line |
|---|---|---|---|
| On Grab | `Grab` | one episode | `Episode Downloading: Severance S02E03 · not guaranteed` |
| On Grab | `Grab` | several episodes | `Episodes Downloading: The Bear S03 (8) · not guaranteed` |
| On File Import | `Download` with `episodeFile` | `isUpgrade` false | `Episode Added: Severance S02E03` (grouped, see section 4) |
| On File Upgrade | `Download` with `episodeFile` | `isUpgrade` true | `Episode Upgraded: Severance S02E03, now 4K` (grouped) |
| On Import Complete | `Download` with `episodeFiles` | | one grouped line, e.g. `Episodes Added: The Bear S03 (8)` (section 4) |
| On Rename | `Rename` | | `Files Renamed: The Bear` |
| On Series Add | `SeriesAdd` | | `Series Monitored: The Bear` |
| On Series Delete | `SeriesDelete` | `deletedFiles` false | `Series Unmonitored: The Bear` |
| On Series Delete | `SeriesDelete` | `deletedFiles` true | `Series Removed: The Bear` |
| On Episode File Delete | `EpisodeFileDelete` | `deleteReason` is not `upgrade` | `Episode Removed: Severance S02E03` |
| On Episode File Delete For Upgrade | `EpisodeFileDelete` | `deleteReason` is `upgrade` | none |
| On Health Issue/Restored, On Application Update, On Manual Interaction Required | | | none |

### Chaptarr

Format comes from the file quality (`M4B`/`MP3` mean Audiobook, `EPUB` means Ebook; the `/audiobooks` or
`/ebooks` path root also says it). Use "Book" when it's unknown.

| Trigger (UI) | `eventType` | Condition | Event log line |
|---|---|---|---|
| On Grab | `Grab` | | `Audiobook Downloading: Dune Messiah · not guaranteed` (or `Ebook`) |
| On Release Import | `Download` | `isUpgrade` false | `Audiobook Added: Dune Messiah` (or `Ebook Added`) |
| On Upgrade | `Download` | `isUpgrade` true | `Audiobook Upgraded: Dune Messiah` |
| On Book Delete | `BookDelete` | `deletedFiles` false | `Book Unmonitored: Dune Messiah` |
| On Book Delete | `BookDelete` | `deletedFiles` true | `Book Removed: Dune Messiah` |
| On Book File Delete | `BookFileDelete` | | `Audiobook Removed: Dune Messiah` (or `Ebook Removed`) |
| On Author Delete | `AuthorDelete` | `deletedFiles` false | `Author Unmonitored: Frank Herbert` |
| On Author Delete | `AuthorDelete` | `deletedFiles` true | `Author Removed: Frank Herbert` |
| anything else | | | none |

Chaptarr's Book File Delete has no reason field. Jordan should leave "On Book File Delete For Upgrade"
unticked in Chaptarr, or upgrades will show as "Removed".

### Formatting rules

- **Episode codes:** `S02E03`. Several episodes in one season: `S03 (8)`. Across seasons: the series
  title with a count, `The Bear (12)`.
- **Movie titles** include the year. Series titles include the year only when the title has a
  duplicate in Sonarr. Defaulting to no year is acceptable.
- **"now X" on upgrades** comes from the new file's quality name, as a resolution: `2160p` becomes 4K;
  `1080p` and `720p` stay as they are; anything else is left out.
- **The table lives in code as one mapping,** so changing wording is a one-line edit with a test.
- **Length:** each line stays under 200 characters, and titles are cut with an ellipsis.

## 4. Sonarr grouping

Sonarr sends one `Download` per episode file, then one Import Complete per download, so a season pack
arrives as 11 posts. Only one line should show:

1. **Each per-file event** (`episodeFile` present) is stored as a pending row that isn't shown, keyed by
   `episodeFile.id`. It records whether it was an upgrade.
2. **Import Complete** (`episodeFiles` present) consumes the pending rows for its file ids. It writes one
   line:
   - "Upgraded" if any consumed row was an upgrade, otherwise "Added";
   - singular or plural by file count.
3. **Leftover pending rows:** any not consumed within 10 minutes are published individually. This covers
   Import Complete being unticked, or a lost post.
4. **Import Complete with no matching pending rows** still writes its line.

Every write is idempotent across 2 workers, using a unique key per app, event and file (or download) id.

## 5. Endpoint and settings

- **The route:** `POST /api/webhooks/{app}`, where `app` is one of `sonarr`, `radarr` or `chaptarr`.
  The existing `/api/webhooks/chaptarr` keeps its current behaviour (catalog rebuild and Kavita scan on
  import) and also writes library lines.
- **Auth:**
  - HTTP Basic, password only, compared in constant time, reusing the Chaptarr helpers.
  - One secret per app: `integration.sonarr.webhook_secret`, `integration.radarr.webhook_secret`, and the
    existing `integration.chaptarr.webhook_secret`.
  - An empty secret refuses every call.
- **Rate limit:** a per-app limit roomy enough for a full-series import (at least 600/min). It must not
  be the shared 60/min per-IP tier, because Sonarr doesn't retry.
- **Responses:**
  - 204 for accepted or ignored events;
  - 401 for bad auth, 404 for an unknown app, 422 for a body that isn't JSON;
  - never a 500.
- **Settings > Integrations:** each of the three cards shows:
  - the webhook URL (the site's own origin plus the path);
  - a generate/rotate secret control;
  - a short line listing which triggers to tick, taken from section 3.

  Secrets are shown only on generate, matching how the Chaptarr secret works today.

## 6. Feed and display

- **Storage:**
  - Rows are `StatusUpdate` with a new `source` value, `library`, plus the fields grouping needs (app,
    event key, pending flag).
  - Library rows are never pinned, never pushed, and never count as outages in `state()`, `home_off()`
    or `status-summary`.
  - They are kept for 30 days, like the rest of the feed.
- **Event log:**
  - Library lines use a neutral grey tick (`--color-text-secondary`).
  - " · not guaranteed" is a muted span after the title.
  - An open outage stays pinned in the log until it resolves, so library lines can't push it out of
    view. The wheel shows the pinned outage plus the newest lines, 4 in all.
- **The feed API** returns library items in the same `items` list, with `source: "library"`.

## 7. Errors and privacy

- Malformed or unknown payloads are logged at info level without the body, and get no line.
- A line never contains a requester, a user, a path or a release name. It holds only the action, the
  title, the year, the episode code, the count and the resolution.

## 8. Plex reachability (ops, no code)

Jordan wants Plex checks in Uptime Kuma, not WebServarr. The Kuma changes:

1. **Inside check:** change the existing "Plex Media Server" monitor in place (keeping its id and
   history) from `port` to an HTTP(s) keyword monitor on `http://<Plex LAN IP>:32400/identity` over
   WireGuard. The keyword is `machineIdentifier`. Set 1 retry.
2. **Outside check:** add a new monitor, "Plex remote access", as an HTTP(s) keyword monitor on
   `https://home.<domain>:32400/identity`. Ignore TLS errors, because Plex's certificate is for
   plex.direct. The keyword is `machineIdentifier`. Set 1 retry, and add it to the status page.

WebServarr picks up both monitors through its existing Uptime Kuma feed. Who makes the change (Jordan or
an agent) is open.

## 9. Testing

- **Python:**
  - every row of section 3, built from payloads based on the spike's field tables;
  - Sonarr grouping (season pack, single episode, upgrade in a pack, Import Complete unticked, Complete
    without pending rows);
  - idempotency under 2 workers;
  - auth per app;
  - the rate limit;
  - the Chaptarr endpoint's existing catalog behaviour is unchanged;
  - library rows are excluded from state, pins, push and status-summary;
  - privacy (no requester, path or release name in the output).
- **Node runtime:** grey tick, the muted "not guaranteed" span, a pinned outage staying visible under a
  burst of 10 library lines.
- **Live on dev:** post real-shaped payloads for each app to the dev endpoint with a test secret. Check
  the lines on Home at 1440 and 375. Then delete the test rows and clear the test secret.

## 10. Out of scope

Download-failure detection; Plex checks inside WebServarr; per-user filtering of library lines.
