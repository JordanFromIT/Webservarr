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
- **Format:** `<Action>: <Title>`, one short line. The plain-English action comes first, in Title Case.
  Wording revised with Jordan on 2026-10-06 (section 3): no media-type word in the action, and upgrades
  name no resolution.
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
| On Grab | `Grab` | | `Downloading: Dune (2021) · not guaranteed` |
| On File Import | `Download` | `isUpgrade` false | `Added: Dune (2021)` |
| On File Upgrade | `Download` | `isUpgrade` true | `Upgraded: Dune (2021)` |
| On Movie Added | `MovieAdded` | | `Monitored: Dune Messiah (2026)` |
| On Movie Delete | `MovieDelete` | `deletedFiles` false | `Unmonitored: Dune (2021)` |
| On Movie Delete | `MovieDelete` | `deletedFiles` true | `Removed: Dune (2021)` |
| On Movie File Delete | `MovieFileDelete` | `deleteReason` is not `upgrade` | `Removed: Dune (2021)` |
| On Movie File Delete | `MovieFileDelete` | `deleteReason` is `upgrade` | none |
| On Movie File Delete For Upgrade, On Rename, On Health Issue/Restored, On Application Update, On Manual Interaction Required | | | none |

### Sonarr

| Trigger (UI) | `eventType` | Condition | Event log line |
|---|---|---|---|
| On Grab | `Grab` | one episode | `Downloading: Severance S02E03 · not guaranteed` |
| On Grab | `Grab` | several episodes | `Downloading: The Bear S03 (8 episodes) · not guaranteed` |
| On File Import | `Download` with `episodeFile` | `isUpgrade` false | `Added: Severance S02E03` (grouped, see section 4) |
| On File Upgrade | `Download` with `episodeFile` | `isUpgrade` true | `Upgraded: Severance S02E03` (grouped) |
| On Import Complete | `Download` with `episodeFiles` | | one grouped line: `Added: Severance S02E03`, `Added: The Bear S03 (8 episodes)`, or `Upgraded: The Bear S03 (8 episodes)` (section 4) |
| On Rename | `Rename` | | `Files Renamed: The Bear` |
| On Series Add | `SeriesAdd` | | `Monitored: The Bear` |
| On Series Delete | `SeriesDelete` | `deletedFiles` false | `Unmonitored: The Bear` |
| On Series Delete | `SeriesDelete` | `deletedFiles` true | `Removed: The Bear` |
| On Episode File Delete | `EpisodeFileDelete` | `deleteReason` is not `upgrade` | `Removed: Severance S02E03`, or `Removed: The Bear S03 (8 episodes)` |
| On Episode File Delete For Upgrade | `EpisodeFileDelete` | `deleteReason` is `upgrade` | none |
| On Health Issue/Restored, On Application Update, On Manual Interaction Required | | | none |

### Chaptarr

Format comes from the file quality (`M4B`/`MP3` mean audiobook, `EPUB` means ebook; the `/audiobooks` or
`/ebooks` path root also says it). When it's unknown the line has no format.

| Trigger (UI) | `eventType` | Condition | Event log line |
|---|---|---|---|
| On Grab | `Grab` | | `Downloading: Dune Messiah (audiobook) · not guaranteed` (or `(ebook)`) |
| On Release Import | `Download` | `isUpgrade` false | `Added: Dune Messiah (audiobook)` (or `(ebook)`) |
| On Upgrade | `Download` | `isUpgrade` true | `Upgraded: Dune Messiah (audiobook)` |
| On Book Delete | `BookDelete` | `deletedFiles` false | `Unmonitored: Dune Messiah` |
| On Book Delete | `BookDelete` | `deletedFiles` true | `Removed: Dune Messiah` |
| On Book File Delete | `BookFileDelete` | | `Removed: Dune Messiah (audiobook)` (or `(ebook)`) |
| On Author Delete | `AuthorDelete` | `deletedFiles` false | `Unmonitored: Frank Herbert (author)` |
| On Author Delete | `AuthorDelete` | `deletedFiles` true | `Removed: Frank Herbert (author)` |
| anything else | | | none |

Chaptarr's Book File Delete has no reason field. Jordan should leave "On Book File Delete For Upgrade"
unticked in Chaptarr, or upgrades will show as "Removed".

### Formatting rules

- **One short line:** `<Action>: <Title>` plus an optional suffix. The action never names the media type.
- **Episode codes:** `S02E03`. Several episodes in one season: `S03 (8 episodes)`. Across seasons: the
  series title with a count, `The Bear (12 episodes)`.
- **Movie titles** include the year. Series titles include the year only when the title has a
  duplicate in Sonarr. Defaulting to no year is acceptable.
- **Books** carry their format after the title, `(audiobook)` or `(ebook)`, and nothing when it is
  unknown. **Authors** carry `(author)`.
- **Upgrades** name no resolution or quality.
- **The table lives in code as one mapping,** so changing wording is a one-line edit with a test.
- **Length:** each line stays under 200 characters. Only the title is cut, with an ellipsis; the year,
  episode code, count, format, `(author)` and the grab note are never cut.
- **Stored lines keep their words.** A wording change applies to new events only; older rows age out
  after 30 days.

## 4. Sonarr grouping

Sonarr sends one `Download` per episode file, then one Import Complete per download, so a season pack
arrives as 11 posts. Only one line should show:

1. **Each per-file event** (`episodeFile` present) is stored as a pending row that isn't shown, keyed by
   `episodeFile.id`. It records whether it was an upgrade.
2. **Import Complete** (`episodeFiles` present) consumes the pending rows for its file ids. It writes one
   line:
   - "Upgraded" if any consumed row was an upgrade, otherwise "Added";
   - the episode code for one file, else the count, `S03 (8 episodes)`.
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
  - Library rows are never pinned and never pushed. Library rows never count as outages; they do
    count as feed content for showing the log. So they never move `state()` or `status-summary`,
    but without Uptime Kuma `home_off()` (and the same rule in home.js) shows the event log when it
    has a note, an outage or a library line from the last 30 days.
  - They are kept for 30 days, like the rest of the feed.
- **Event log:**
  - Library lines use a neutral grey tick (`--color-text-secondary`).
  - " · not guaranteed" is a muted span after the title.
  - What the feed pins (an open outage, an open important note) is a row of its own between the
    "Event log" heading and the wheel, not a line on the wheel, so library lines can't push it out of
    view and the wheel keeps rolling the rest (5 lines, scroll-back as before). Each row: an icon
    (`error` in `--ws-status-err` for an outage, `warning` in `--ws-status-warn` for a note), the
    text, and the time in the wheel's time column. The rows are a list named "Current problems",
    the icon hidden from screen readers behind a visually hidden "Problem:" or "Important:"; a new
    row is announced through the log's polite live region.
  - The server writes the rows into Home's HTML (app/home_event_log.py, the same markup as
    home.js, kept in step by app/tests/event_pinned_vectors.json), so nothing moves when the script
    takes over. A row that appears or goes after load is a real status change and may move the page.
  - Resolved, an outage's row goes and its "is down" and "is back, down N min" lines join the
    wheel's history (the return turns in and is announced); a resolved or unpinned note joins the
    history at its own time, unannounced.
- **The feed API** returns library items in the same `items` list, with `source: "library"`.

## 7. Errors and privacy

- Malformed or unknown payloads are logged at info level without the body, and get no line.
- A line never contains a requester, a user, a path or a release name. It holds only the action, the
  title, the year, the episode code, the count, a book's format and `(author)`.

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
  - library rows are excluded from state, pins, push and status-summary, but alone keep the event
    log shown without Uptime Kuma (the server's hidden hint and home.js agree);
  - privacy (no requester, path or release name in the output).
- **Node runtime:** grey tick, the muted "not guaranteed" span, a pinned outage staying visible under a
  burst of 10 library lines.
- **Live on dev:** post real-shaped payloads for each app to the dev endpoint with a test secret. Check
  the lines on Home at 1440 and 375. Then delete the test rows and clear the test secret.

## 10. Out of scope

Download-failure detection; Plex checks inside WebServarr; per-user filtering of library lines.
