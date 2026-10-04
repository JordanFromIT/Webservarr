# Home redesign, status feed and audit design items

This is part of v2 roadmap step 5. Status: designed on 2026-10-04 from Jordan's decisions (recorded
in `V2-ROADMAP.md`, step 5 notes, 2026-10-04) and the AI-giveaways audit
(`AI-GIVEAWAYS-AUDIT-2026-10-04.md`). The audit's seven design-class items use the orchestrator's
judgment, as Jordan delegated, and Jordan reviews them on dev. It builds on the phone navigation
spec (`2026-10-04-mobile-nav-and-home-screen-design.md`), which supplies the tab bar, the
home-screen card and the 320 px gauges fix.

## 1. Goal

Users are family and friends, mostly on phones. They come to the site to request things, to read
news, and to find out whether the server is working. Home should lead with those, in the visual
language of the new Books pages. A short live status feed, kept separate from News, should tell
people what just happened.

## 2. Home, top to bottom

1. **Status strip.**
   - **When everything is up:** one slim line, "All services running", with the time of the
     latest status update if there is one.
   - **When something is down, or there is a recent important post:** the strip grows into a
     prominent card. It shows the newest feed item, its time, and a link to the full feed.
   - **Admins** also see the existing gauges and service tiles, below the strip. **Members also
     keep seeing them (Jordan, as today).** They are restyled to the Books language: theme
     variables, no fixed widths, nothing wider than the screen at 320 px.
2. **Requests.**
   - A clear "Request a movie, show or book" entry point that opens Requests.
   - Below it, **everyone's** recent requests (Jordan) with their status, as poster cards in the
     Books card style.
   - Admins also see a "N waiting for approval" link.
3. **News.** The latest one or two posts as readable cards, with a link to all news.
4. **Everything else, in this order:**
   - the Continue row (from 3a);
   - Active Streams, shown to everyone as today, still with **no names**;
   - Coming soon (calendar);
   - the add-to-home-screen card (from the phone navigation spec).

**General rules:**
- No "Good evening" greeting.
- Zero layout shift. Every section reserves its space.
- No overflow at 320, 375 or 430 px.
- Built with the Books patterns: skeletons, top-down arrival, theme variables only.

## 3. Status feed

### Data

Reuse the existing `StatusUpdate` model. Add whatever fields it lacks:

- **`source`:** `auto` (Uptime Kuma) or `admin`.
- **`important`:** a boolean.
- **`service`:** the monitor name, for auto posts.
- **`started_at` / `ended_at`:** for outages.
- **`pushed_at`:** set once a push has been sent.

### Automatic posts from Uptime Kuma

- The background poller already reads Uptime Kuma's status page. It detects transitions per
  monitor:
  - **Up to down:** creates "<Service> is down" (incident).
  - **Back up:** closes it as "<Service> is back, down <duration>" (resolved).
- Each transition is posted once, across 2 workers, using a lock or a unique key per monitor and
  incident.
- Flapping is debounced: a monitor must stay down for 2 consecutive polls before an incident opens.
- Service names come from the operator's Uptime Kuma. No instance names live in code.

### Admin posts

In Settings, an admin can post a short note (up to 280 characters), with an optional
"important" toggle and an optional service. Notes can be edited, deleted, or marked resolved.

### Push notifications

A push goes out only:
- for an auto incident that has stayed down for **10 minutes**;
- for an admin post marked important.

Each update pushes at most once. A new notification preference category, **`status`**, is on by
default and per user, and joins `NOTIFICATION_CATEGORIES` and notifications.js in the same
commit.

### Where the feed appears

- **Home:** the status strip (section 2).
- **A feed page, `/status`:** the newest first, with times, open incidents pinned, and the last
  30 days of history. It is reachable from the strip.
- **Login page:** one line only, "All services running" or "<Service> is down". It uses the
  existing public `/api/integrations/status-summary` endpoint, extended so it can name the down
  service. It still never reveals other details or any history.

## 4. The audit's design items (orchestrator's judgment; Jordan reviews on dev)

- **H3. Stat-card rows on Issues, Tickets and Requests.** Remove the identical count cards. Each
  page leads with what a person came for: their open items and a clear primary action. Counts
  shrink into one quiet line.
- **M3 and M8. Three visual dialects; Requests split into one section per API.** Restyle Requests
  in the Books language:
  - one search;
  - shelves grouped by what people want ("Trending", "Coming soon", "Books"), not by backend;
  - poster cards matching Books.
  - Issues, Tickets, Wiki and News adopt the same card, type scale and spacing, with no new
    features.
- **M7. Login card.** Restyle it to the Books language and the brand. Add the one-line status
  (section 3). It must keep the existing visibility and auth-ready behaviour exactly; see the
  CLAUDE.md footgun note.
- **L4. Secondary palette is Tailwind's defaults.** Derive the status, gauge and media colours
  from the theme engine, with settings defaults that harmonise with the brand palette. Never
  hardcode them.
- **L8. First-visit fallback font.** Preload the primary font, and use `font-display` with a
  metric-matched fallback so text doesn't visibly change and layout doesn't shift.

## 5. Errors and privacy

- Responses are 4xx or 503 only, never 500.
- When Uptime Kuma is unreachable, the strip says "Status unavailable right now" and never claims
  that everything is running.
- The public status summary reveals only the current one-line state.
- Active Streams never shows names.

## 6. Testing

- **Python:**
  - transition detection, debounce and posting once across 2 workers;
  - the push threshold and posting once;
  - admin note create, read, update and delete, plus validation;
  - preference gating;
  - the status-summary privacy check;
  - migrations under 2 workers.
- **Node runtime:** every Home section and its states (all up, down, important, empty), the
  `/status` page, the login line and the restyled pages.
- **One live check on dev with the devkit:**
  - Home at 320, 375, 430 and 1440 px, as admin and as member;
  - a simulated outage (intercept, or a test monitor transition) that moves through strip,
    feed, push and resolved;
  - an admin note;
  - the login line;
  - screenshots of every restyled page.
  - CLS 0 and no overflow throughout, with everything restored afterwards.

## 7. Out of scope

Status from sources other than Uptime Kuma and the admin; incident comments or subscriptions;
public status for signed-out users beyond the one line.
