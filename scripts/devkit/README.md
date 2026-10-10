# Dev test kit

Plumbing for live checks on a dev instance: signed-in test sessions, seeded
listening rows, exact restore, and a headless browser. Two halves:

- `devkit.py` runs **inside the dev container** (it imports the app).
- `browser.mjs` runs **wherever the browser is** and talks to the dev site over
  HTTPS. Node 22+, no packages.

## The rule

**Every live check ends with `restore` or `cleanup`.** Take a `snapshot` first
and finish with `restore` when the check touched settings or any shared row;
use `cleanup` when it only created test-identity rows and sessions.

Test identities live in a reserved range, `plex:990000` to `plex:990099`. The
kit seeds, deletes and signs in only inside that range, and refuses anything
else. A session is the kit's if its identity is in the range.

## Calling devkit.py

The repo is not mounted in the container (only `app/` and `data/` are), so the
script is fed through stdin from the dev checkout, which `ws-dev-sync` or a
`git pull` keeps current. Set these once:

```bash
export DEVKIT_SSH=<ssh host of the dev server>
export DEVKIT_CONTAINER=<dev container name>
export DEVKIT_CHECKOUT=<dev checkout path on that host>
dk() { ssh "$DEVKIT_SSH" "docker exec -i $DEVKIT_CONTAINER python - $(printf ' %q' "$@") < $DEVKIT_CHECKOUT/scripts/devkit/devkit.py"; }
```

Then, for example, `dk cleanup`. Results go to stdout, refusals and warnings to
stderr, exit 0 on success, 1 on a refusal or failure, 2 on bad arguments.
Nothing it prints is a secret.

The kit runs only on the dev instance. Before any command it reads the
container's `/proc/self/mountinfo` and refuses unless the folder holding the
database is bind-mounted from a dev checkout (a host folder whose name ends in
`-dev`, as `<checkout>-dev/data`). Piped into any other container, it stops
before it opens the database or mints a session. Nothing needs passing for it.

## Commands

```bash
# Sign in: prints ONLY the cookie value (the session id), on stdout.
SID=$(dk session --role admin --kavita-link)       # admin, plex:990001, linked to Kavita
SID=$(dk session --role member --identity plex:990003)

# Save the tables a check touches (listening rows, player prefs, settings, pairing choices).
dk snapshot before-books
dk snapshot before-books --also books,book_audio_editions   # more tables

# Seed a place in a book (a row for a test identity, replacing any for that book).
dk seed-listen --identity plex:990001 --book-key 283644:1 --ms 5000000
dk seed-listen --identity plex:990001 --book-key 283644:1 --ms 5000000 --duration-ms 72000000 --minutes-ago 30

# Seed a place in a book that is NOT in the library (the "were you listening to one of these?" case).
dk seed-orphan --identity plex:990001 --book-key 990011:1 --author "Some Author" --title "Gone Book" --ms 1200000

# Seed a request for access (Settings > Access requests). Its username is devkit-<id>.
# NEVER approve a seeded request on a live site: approving shares the real Plex server
# with whoever holds that username. Live checks intercept the approve route.
dk seed-access --identity plex:990011                       # pending
dk seed-access --identity plex:990012 --status approved --share-state failed --share-error "Plex refused the share (HTTP 400)"
dk seed-access --identity plex:990013 --status blocked

# Insights (the admin's reading and listening page): listening, reading and requests.
dk seed-log --identity plex:990011 --book-key 283644:1 --minutes-ago 90 --minutes 20      # within the last 48 hours
dk seed-hour --identity plex:990011 --book-key 283644:1 --hours-ago 200 --minutes 45     # any age
dk seed-request --identity plex:990011 --title "Dune" --format both --days-ago 3
dk seed-ebook --identity plex:990011 --book-id 7 --page 40 --pages 300 --days-ago 40     # 40 days: abandoned
dk seed-reading --identity plex:990011 --pages-read 100 --days-ago 2                     # 100 pages read 2 days ago
dk seed-reading --identity plex:990011 --pages-read 160 --days-ago 1                     # and 160 yesterday: 260 in all

# Put the snapshot back exactly, check it matches, delete the kit's sessions and the snapshot.
dk restore before-books

# Remove every row of the reserved identities and every kit session. No snapshot needed.
dk cleanup
```

Notes:

- `--kavita-link` signs the session in to Kavita with the configured key. Without
  it, `/books` and the book pages start the Kavita hand-off and leave the site.
- The session carries the admin Plex token (read inside the container, never
  printed), so the player works for either role.
- A snapshot lives in `/tmp/devkit` in the container (mode 600, because settings
  hold secrets). It is deleted by `restore`, and it never overwrites an older one
  of the same name. A container recreate loses it.
- `restore` writes the database directly. If a check changed a setting through the
  app, expect the app to read it back on the next request, not instantly.
- The kit does not undo what the app does outside its own database: a real listen or
  a confirmed link writes a place to Plex, and Kavita keeps any reading progress.
  Read those before and put them back by hand. Rate-limit counters expire on their own.

## Calling browser.mjs

The dev address is never defaulted: pass `baseUrl` or set `DEVKIT_BASE_URL`.
The browser is `DEVKIT_BROWSER` (default `brave`); the cookie name is
`DEVKIT_COOKIE_NAME` (default `webservarr_session`).

One page, one report, from the command line (the cookie travels in the
environment, so it never appears in `ps`):

```bash
DEVKIT_BASE_URL=<dev address> DEVKIT_COOKIE=$SID \
  node scripts/devkit/browser.mjs /books --width 320 --shot /tmp/books-320.png
# prints { cls, shifts, overflow: { scrollWidth, clientWidth, viewport, overflows }, consoleErrors }

# Simulate a source being down: answer matching requests with a status.
DEVKIT_BASE_URL=<dev address> DEVKIT_COOKIE=$SID \
  node scripts/devkit/browser.mjs /books --width 1440 --intercept '*/api/books/continue*=503'
```

From a script:

```js
import { launch } from './scripts/devkit/browser.mjs';

const b = await launch();                       // temp profile, deleted on close
try {
  await b.setSession(cookieValue);
  const stopFailing = await b.intercept('*/api/books/continue*', 503);
  await b.goto('/books', { width: 320 });       // under 600 wide emulates a phone
  await b.screenshot('/tmp/books-320.png');     // { fullPage: true } for the whole page
  console.log(await b.measure());               // cls, overflow, consoleErrors
  await stopFailing();                          // or b.clearIntercepts()
} finally {
  await b.close();                              // kills the browser, deletes the profile
}
```

`b.evaluate(expression)` runs a script in the page and `b.call(method, params)`
sends any DevTools command (for example `Input.dispatchMouseEvent` for a real
click). Console errors include the browser's own "Failed to load resource" lines,
which a forced 503 produces on purpose.

## A full round trip

```bash
dk snapshot rt
SID=$(dk session --role admin --kavita-link)
DEVKIT_BASE_URL=<dev address> DEVKIT_COOKIE=$SID \
  node scripts/devkit/browser.mjs /books --width 320 --shot /tmp/books-320.png
dk restore rt
```

## Tests

`python3 -m unittest discover -s scripts/devkit -t scripts/devkit` (stdlib only,
no app needed) covers the reserved-range guard, seeding, cleanup scope and the
snapshot and restore round trip. The dev suite does not discover it.
