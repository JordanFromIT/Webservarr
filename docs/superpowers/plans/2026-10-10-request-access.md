# Request access from the sign-in page: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a stranger can ask for access from inside the frosted sign-in card by proving their Plex account, and the admin approves (which shares the Plex server with that account) or denies in Settings > Access requests.

**Architecture:** one new table (`access_requests`) and one join table for the admin's notifications (`admin_contacts`); a service module that owns the database rules; a Plex share client that talks to plex.tv with the admin token; one router with three public routes (Plex PIN, identify, submit) and five admin routes; the card's steps as static blocks in `login.html` driven by a new `login-request.js`; a new Settings tab module. Nothing in the flow creates a session, and the requester's Plex token never leaves the identify call.

**Tech Stack:** FastAPI, SQLAlchemy on SQLite, Redis (redis.asyncio), httpx, vanilla ES2017 scripts, Tailwind (precompiled), happy-dom for front-end tests, unittest for Python.

**Spec:** `docs/superpowers/specs/2026-10-10-request-access-design.md` (approved by Jordan 2026-10-10, amended the same day: section 8 finds the admin by Plex account id, never by email). Read it first; this plan argues from it.

## Global Constraints

Every task's requirements include all of these.

**Gates (Jordan):**
- Tasks 1, 2 and 3 are gates. Task 1 needs Jordan present; Task 2 may need Jordan to look at one Authentik screen; Task 3 needs Jordan's approval of the mockup.
- No front-end build task (Tasks 9 and 10) starts until Jordan has approved the Task 3 mockup in writing. Backend tasks (4 to 8) may run before and while the mockup is reviewed.
- If a gate's answer changes the design (Plex refuses both share routes, Authentik does not enroll new users), stop the plan and report to Jordan. Do not improvise a different design.

**Project facts:**
- FastAPI + SQLAlchemy on SQLite. `Base.metadata.create_all` makes new tables on existing databases, so a new table needs no migration (a new column on an old table would).
- Two uvicorn workers. Anything shared between requests goes through Redis (`await session_manager.get_redis()`) or the database, never module state. No module-level caches.
- Front end: vanilla ES2017, the soft-navigation shell for app pages. `/login` is a full-page document, not a soft-navigation page.
- CSP is `script-src 'self'`: no inline `<script>` blocks and no inline event handlers. Every script is a file.
- Tailwind is precompiled. After any change to a file under `app/static/**/*.html`, `app/static/js/**/*.js` or `app/pages.py`, run `npm run build:css` and commit `app/static/css/app.css`. The app.css freshness stamp also hashes the JS files, so a JS-only edit still needs the rebuild, or CI's `test_css_build` fails.
- The icon-font test reads every lowercase word between quotes or backticks, comments included, as a possible Material Symbols name (`app/tests/test_icon_font.py`). Do not put plain words in backticks in comments unless the word is an icon in `app/static/fonts/material-symbols-outlined.icons.txt` or in that test's `NOT_ICONS`.
- Static tests count `getJSON(` calls in page modules and expect every list to be read through `readLive`. This feature adds no page module; the sign-in card and the Settings tab use `fetch` as their neighbours (`login.js`, `settings/books.js`) do. If you ever add a `WS.getJSON` to a page module, route it through that module's `readLive`.
- happy-dom tests live in `app/tests/js/` and run with `npm run test:js` (run `npm ci --no-audit --no-fund` once in a fresh worktree first). Every new `.mjs` is added to `package.json` `test:js` AND to the `js-checks` step list in `.github/workflows/docker-publish.yml`.
- User text and anything from Plex is set with `textContent`, never HTML strings. Colours come from theme variables only (the Plex amber `#E5A00D` on Plex buttons is the one existing brand exception).
- Error responses are 4xx or 503 only, never 500 on purpose.
- Logging: request id, Plex account id and outcome only. Never a note, an email, a token, a cookie or a session id.

**Commands (each its own Bash call; never chain push, pull or test commands with `&&` or `;`):**
- Worktree per task, from the main clone: `git -C ~/Documents/Git-Repos/Webservarr fetch origin` then `git -C ~/Documents/Git-Repos/Webservarr worktree add -b wip/request-access-tN ~/Documents/Git-Repos/Webservarr-wt-request-access-tN origin/dev` (N is the task number).
- Red step for a new Python test file, against dev's current code, before anything is pushed: `ssh webserver "docker exec -i webservarr-dev python - -v" < app/tests/<file>.py` (run from the worktree root; every new test file ends with `if __name__ == "__main__": unittest.main()`).
- One Python test module on dev: `ssh webserver "docker exec webservarr-dev python -m unittest app.tests.<module> -v"`.
- The full Python suite on dev: `ssh webserver "docker exec -e WEBSERVARR_FORBIDDEN_STRINGS='<operator list>' webservarr-dev python -m unittest discover -s /app/app/tests -t /app"`. The operator list is in the dispatch brief (it is the same list as the full-suite command in `docs/superpowers/plans/2026-10-03-books-page-core.md`, Global Constraints). It is not copied here because instance names stay out of committed files.
- Dev kit tests, locally: `python3 -m unittest discover -s scripts/devkit -t scripts/devkit`.
- Deploy to dev, in order, each its own command: `git fetch origin`; `git rebase origin/dev`; `git push origin wip/request-access-tN:dev`; `ssh webserver "cd ~/webservarr-dev && git pull --ff-only"`; `ssh webserver "docker restart webservarr-dev"` only when Python or partials changed. Then `gh run list --branch dev --limit 1` and `gh run watch <run id> --exit-status`. CI must be green before the task counts as done; a red run is fixed by a new commit, never by force-pushing.
- Live checks use `ws-dev-browser` (`--role admin` is the default, `--role member` exists; script mode lets a script stay signed out by not calling `setSession`). Only one at a time: run `pgrep -f ws-dev-browser` first and wait if it prints anything. It cleans up the kit's sessions and reserved rows at exit.

**Git:** the repo's own identity (already configured), commit subjects in the repo's `type(scope): words` style, no Claude or Anthropic co-author trailer. Stage explicit paths only.

**Writing:** no em dashes or en dashes anywhere: code, comments, copy, commit messages, reports. No instance names (site names, domains) in committed files.

**Safety:**
- Never touch production: not `~/webservarr`, not the `webservarr` container, not its database, not its address. Dev only.
- Never print a token, a cookie value or a session id, in a command, an output or a report.
- Never click Request on the Requests page on dev. Never save a dev setting unless the task says the check needs it and Jordan has approved it; every such change is wrapped in a dev kit `snapshot` and `restore`.
- The only Plex account the build may ever share the server with is Jordan's test account, `jordanfromit912`, and only in Task 1 and Task 11, with Jordan present. Never send DELETE (or any other removal) to Plex; Jordan removes shares himself. Every other live check intercepts the approve route so no share can happen.
- No `rm`, `mv` or `chmod` on any remote host except the agent's own files under `/tmp`.
- On any permission denial, stop and report.

**Route rules (spec section 6):**
- Every new route gets tests for a signed-out caller, a member and an admin. Admin routes live under `/api/admin`, use `require_admin`, and must pass `app/tests/test_settings_gate.py` (it sweeps every `/api/admin` route from the OpenAPI document).
- Public routes get rate-limit tests and input-limit tests.
- Every POST carries `require_same_origin`; every POST with a JSON body also carries `require_encodable_body` (both imported from `app.routers.player`). None is added to the same-origin sweep's exemptions.

**Audit:** the three public routes, the identify flow and the callback page's `for=access` branch join the v2.0 security audit scope (roadmap step 6). The audit itself is not part of this plan.

## Review Focus

These are the inputs the spec implies but does not spell out, most likely to bite first. Each has its test in the named task.

1. **The PIN completes twice:** the popup's message and the popup-closed poll (or a second tab) both call identify for one PIN. One answer wins, the other gets 409, and the card never flashes an error or skips a step. *(Task 7 server test, Task 9 card test)*
2. **A phone comes back without its PIN:** Plex returns to `/login?access_request=complete` in a different browser or tab (an in-app browser, a cleared session), so `sessionStorage` has no `access_pin_id`. The card shows step S1 with "That Plex sign-in expired. Start again.", never a dead "Waiting for Plex" step. *(Task 9)*
3. **Double presses:** "Send request" pressed twice fast makes one request; "Share and approve" pressed twice shares once. *(Task 7 and Task 9 for send; Task 8 and Task 10 for approve)*
4. **Plex is down when the admin presses Approve:** the library list cannot load. The dialog does not open with an empty list, the admin sees why, and the row stays pending. *(Task 8 server test, Task 10 tab test)*
5. **Hostile or huge text:** a name or note holding markup, control characters, a 1000-character unbroken word, or line breaks. The server refuses control characters, keeps newlines in the note, and the admin card shows the note as text with its line breaks and no horizontal overflow at 390 wide. *(Task 4 and Task 7 for the rules, Task 10 for the rendering, Task 11 live at 390)*

## File map

| File | Task | Responsibility |
|---|---|---|
| `app/models.py` | 4, 6 | `AccessRequest`, `AdminContact` |
| `app/settings_registry.py` | 4 | `access_requests.enabled`, `access_requests.default_libraries` and its check |
| `app/routers/branding.py` | 4 | `auth_methods.request_access` |
| `app/services/access_requests.py` (new) | 4, 6, 8 | Database rules: gate, form rules, states, submit rules, tidy, notify, admin decisions |
| `app/services/notification_poller.py` | 4 | Hourly tidy in the leader loop |
| `app/integrations/plex_share.py` (new) | 5 | plex.tv: libraries, find a share, share the server |
| `app/services/admin_contacts.py` (new) | 6 | Record and look up where the admin's notifications go |
| `app/routers/auth.py` | 6, 7 | Record the admin contact at OIDC sign-in; three-way `_server_membership` |
| `app/routers/plex_auth.py` | 6 | Record the admin contact at Plex sign-in |
| `app/routers/notifications.py`, `app/static/js/notifications.js` | 6 | The `access` category |
| `app/static/fonts/*` | 6 | The `person_add` icon in the trimmed font |
| `app/routers/access_requests.py` (new) | 7, 8 | Public router and admin router |
| `app/main.py` | 7, 8 | Register both routers |
| `app/static/js/plex-callback.js` | 7 | The `for=access` hand-back |
| `scripts/devkit/devkit.py` | 8 | `seed-access` and cleanup of reserved access rows |
| `app/static/login.html`, `app/static/js/login-request.js` (new), `app/static/js/login.js` | 9 | The card's steps |
| `app/static/settings.html`, `app/static/js/settings/access-requests.js` (new), `app/static/js/settings/kit.js`, `app/static/js/settings/first-paint.js`, `app/static/css/theme.css` | 10 | The Settings tab and its badge |
| `docs/mockups/request-access.html` (new) | 3 | The mockup Jordan approves |

---

### Task 1: Plex share proof (Jordan gate)

The spec's open risk 1: a GET can't prove that a POST shares the right server, with the right libraries, to the right account. This task proves it once, from dev, to Jordan's test account, with Jordan present. Its only commit records what was learnt in the spec.

**Jordan supplied the test account on 2026-10-10: `jordanfromit912`.** The script still takes it as a parameter (`ACCESS_PROOF_PLEX_USER`). If the dispatch brief names a different account, or none, stop and ask Jordan before running any `share-*` mode. It is the only account the build may ever share to.

**Files:**
- Create (scratch, never committed): `$SCRATCH/access_proof.py`, where `$SCRATCH` is the agent's scratchpad directory.
- Modify: `docs/superpowers/specs/2026-10-10-request-access-design.md` (section 3, a new "Proof" table).

**Interfaces:**
- Produces for Task 5: which create route works (A or B), the JSON shape of `owned/pending` and `owned/accepted` entries (the field that names the invited account, whether `invitedId` equals the Plex account id), and whether a share creates a Plex friend.

- [ ] **Step 1: Write the proof script to the scratchpad**

```python
"""Request access, Task 1: share the configured Plex server once with ONE test account.

Runs inside the dev container, fed through stdin (the repo is not mounted there):
  ssh webserver "docker exec -i -e ACCESS_PROOF_PLEX_USER=<user> -e ACCESS_PROOF_LIBRARY_KEYS=<k,k> \
      webservarr-dev python - <mode>" < access_proof.py

Modes:
  libraries  read-only: the server's libraries (key, plex.tv id, title, type)
  check      read-only: does a share already exist for the test user?
  share-a    v1 POST plex.tv/api/servers/{mid}/shared_servers, once, then look for it in owned/pending
  share-b    v2 POST clients.plex.tv/api/v2/shared_servers, once (only after share-a failed), then look
  confirm    read-only: the test user's entry in owned/pending and owned/accepted, and plex.tv/api/users

Prints status codes, ids, field names and library titles only. Never a token. Never DELETE.
"""
import asyncio
import os
import sys
import xml.etree.ElementTree as ET

import httpx

from app.database import SessionLocal
from app.integrations import config
from app.routers.auth import _fetch_configured_server_identifiers, _plex_client_headers

USER = os.environ.get("ACCESS_PROOF_PLEX_USER", "").strip()
KEYS = [k.strip() for k in os.environ.get("ACCESS_PROOF_LIBRARY_KEYS", "").split(",") if k.strip()]
SAFE_FIELDS = ("id", "invitedId", "machineIdentifier", "numLibraries", "allLibraries", "createdAt", "acceptedAt")
NAME_FIELDS = ("username", "title", "email", "invitedEmail", "invitedUsername")


async def context():
    values = config.read([config.url_key("plex"), config.CREDENTIAL_KEYS["plex"]])
    token = config.credential("plex", values)
    if not token:
        sys.exit("Plex isn't configured on dev")
    db = SessionLocal()
    try:
        headers = {**_plex_client_headers(db), "X-Plex-Token": token}
        ids = await _fetch_configured_server_identifiers(db)
    finally:
        db.close()
    if len(ids) != 1:
        sys.exit(f"expected one server id, found {len(ids)}")
    return next(iter(ids)), headers


def names_in(entry):
    """Every name-like value the entry carries for the invited account (lower-cased)."""
    found = set()
    for source in (entry, entry.get("invited") or {}, entry.get("user") or {}):
        if isinstance(source, dict):
            for f in NAME_FIELDS:
                v = source.get(f)
                if isinstance(v, str) and v:
                    found.add(v.strip().lower())
    return found


def safe_view(entry):
    out = {f: entry.get(f) for f in SAFE_FIELDS if f in entry}
    libs = entry.get("libraries") or []
    out["libraries"] = [{k: lib.get(k) for k in ("id", "key", "title")} for lib in libs if isinstance(lib, dict)]
    invited = entry.get("invited") or {}
    out["invited.id"] = invited.get("id") if isinstance(invited, dict) else None
    return out


async def listing(client, headers, state, mid):
    r = await client.get(f"https://clients.plex.tv/api/v2/shared_servers/owned/{state}", headers=headers)
    print(f"owned/{state}: HTTP {r.status_code}")
    if r.status_code != 200:
        return []
    data = r.json()
    print(f"owned/{state}: top-level type {type(data).__name__}")
    rows = data if isinstance(data, list) else []
    ours = [e for e in rows if isinstance(e, dict) and str(e.get("machineIdentifier") or "") == mid]
    mine = [e for e in ours if USER.lower() in names_in(e)]
    if not mine and ours:
        print(f"owned/{state}: no entry names the test user; field names of the first entry: {sorted(ours[0])}")
    for e in mine:
        print(f"owned/{state}: test user entry {safe_view(e)}")
        print(f"owned/{state}: field names {sorted(e)}")
    return mine


async def sections(client, headers, mid):
    r = await client.get(f"https://plex.tv/api/v2/servers/{mid}", headers=headers)
    print(f"servers/{{mid}}: HTTP {r.status_code}")
    r.raise_for_status()
    return [s for s in (r.json() or {}).get("librarySections") or [] if isinstance(s, dict)]


async def main(mode):
    if mode != "libraries" and not USER:
        sys.exit("set ACCESS_PROOF_PLEX_USER")
    mid, headers = await context()
    async with httpx.AsyncClient(timeout=10.0) as client:
        if mode == "libraries":
            for s in await sections(client, headers, mid):
                print({k: s.get(k) for k in ("key", "id", "title", "type")})
        elif mode in ("check", "confirm"):
            await listing(client, headers, "pending", mid)
            await listing(client, headers, "accepted", mid)
            if mode == "confirm":
                r = await client.get("https://plex.tv/api/users", headers={**headers, "Accept": "application/xml"})
                print(f"api/users: HTTP {r.status_code}")
                if r.status_code == 200:
                    users = ET.fromstring(r.text).findall("User")
                    match = [u for u in users if USER.lower() in {(u.get(a) or "").lower() for a in ("username", "title", "email")}]
                    print(f"api/users: test user listed: {bool(match)}; attribute names: {sorted(match[0].attrib) if match else []}")
        elif mode in ("share-a", "share-b"):
            if not KEYS:
                sys.exit("set ACCESS_PROOF_LIBRARY_KEYS")
            if await listing(client, headers, "pending", mid) or await listing(client, headers, "accepted", mid):
                sys.exit("a share already exists for the test user: Jordan removes it first")
            by_key = {str(s.get("key")): s.get("id") for s in await sections(client, headers, mid)}
            ids = [int(by_key[k]) for k in KEYS if k in by_key]
            if len(ids) != len(KEYS):
                sys.exit("a library key is not on the server")
            if mode == "share-a":
                url = f"https://plex.tv/api/servers/{mid}/shared_servers"
                body = {"server_id": mid,
                        "shared_server": {"library_section_ids": ids, "invited_email": USER},
                        "sharing_settings": {"allowSync": "0", "allowCameraUpload": "0", "allowChannels": "0",
                                             "filterMovies": "", "filterTelevision": "", "filterMusic": ""}}
            else:
                url = "https://clients.plex.tv/api/v2/shared_servers"
                body = {"machineIdentifier": mid, "librarySectionIds": ids, "invitedEmail": USER,
                        "settings": {"allowSync": False, "allowCameraUpload": False, "allowChannels": False}}
            r = await client.post(url, json=body, headers=headers)
            print(f"{mode}: POST HTTP {r.status_code}; response field names: "
                  f"{sorted(r.json()) if r.headers.get('content-type', '').startswith('application/json') and isinstance(r.json(), dict) else r.headers.get('content-type')}")
            await listing(client, headers, "pending", mid)
        else:
            sys.exit(f"unknown mode {mode}")


asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else ""))
```

- [ ] **Step 2: List the libraries (read-only)**

Run: `ssh webserver "docker exec -i webservarr-dev python - libraries" < $SCRATCH/access_proof.py`
Expected: one line per library with `key`, `id`, `title`, `type`. No token anywhere in the output.

- [ ] **Step 3: Ask Jordan which library to share, and to be present**

Send Jordan this, verbatim except the list: "Waiting on you: for the Plex share proof I'll share the server with `jordanfromit912` once, from dev. Which library should it get (one is enough)? <the library list from Step 2>. After it's sent I'll need you to accept the invite on that account, sign in to the dev site with it once, then remove the share in Plex yourself." Stop until he answers.

- [ ] **Step 4: Check no share exists yet (read-only)**

Run: `ssh webserver "docker exec -i -e ACCESS_PROOF_PLEX_USER=jordanfromit912 webservarr-dev python - check" < $SCRATCH/access_proof.py`
Expected: `owned/pending: HTTP 200`, `owned/accepted: HTTP 200`, and no "test user entry" line. If either lists the test user, stop and ask Jordan to remove that share first.

- [ ] **Step 5: Share through route A, once**

Run: `ssh webserver "docker exec -i -e ACCESS_PROOF_PLEX_USER=jordanfromit912 -e ACCESS_PROOF_LIBRARY_KEYS=<key Jordan chose> webservarr-dev python - share-a" < $SCRATCH/access_proof.py`
Expected: `share-a: POST HTTP 200` or `201`, then an `owned/pending: test user entry {...}` line whose `libraries` hold exactly the chosen library and whose `machineIdentifier` is the server's. Record the POST status, the entry's field names, `invitedId` and `invited.id`.

- [ ] **Step 6: Only if Step 5 did not show the entry: route B, once**

Run: `ssh webserver "docker exec -i -e ACCESS_PROOF_PLEX_USER=jordanfromit912 -e ACCESS_PROOF_LIBRARY_KEYS=<key> webservarr-dev python - share-b" < $SCRATCH/access_proof.py`
Expected: as Step 5. If route B also fails, stop the plan and report both responses (status codes and field names only) to Jordan: the share client in Task 5 cannot be written until a route is proven.

- [ ] **Step 7: Jordan accepts the invite; confirm (read-only)**

Ask Jordan: "Waiting on you: please accept the Plex invite on `jordanfromit912` (from the email or in a Plex app) and tell me when it's done." Then run:
`ssh webserver "docker exec -i -e ACCESS_PROOF_PLEX_USER=jordanfromit912 webservarr-dev python - confirm" < $SCRATCH/access_proof.py`
Expected: the entry moved from `owned/pending` to `owned/accepted`; record whether `api/users: test user listed:` is True (a Plex friend, or at least a shared user) and ask Jordan to look at Plex Web > Settings > Manage Library Access (and the friends list) and say whether the account shows as a friend.

- [ ] **Step 8: Jordan signs in to dev with the test account**

Ask Jordan: "Waiting on you: please sign in to the dev site in a private window with `jordanfromit912` through Authentik, and tell me whether it lets you in (and whether Authentik made a new account for it on the way)." This proves both WebServarr's membership gate and Task 2's enrollment question in practice. Then ask him to remove the share in Plex himself and to sign the test account out. The agent never sends DELETE.

- [ ] **Step 9: Record the proof in the spec**

In `docs/superpowers/specs/2026-10-10-request-access-design.md`, after the "Verdict" paragraph of section 3, add a subsection with the real values from Steps 5 to 8:

```markdown
**Proof (build task 1, <date>).** Run from dev with the admin token, to Jordan's test account only:

| What | Result |
|---|---|
| Create route that worked | <A (v1 POST plex.tv/api/servers/{mid}/shared_servers) or B (v2 POST clients.plex.tv/api/v2/shared_servers)>, HTTP <status> |
| Confirmed in `owned/pending` | <yes/no>; the entry names the account by <field names>; `invitedId` <equals / does not equal> the account's plex.tv id |
| Libraries on the entry | <exactly the one shared / something else> |
| After acceptance | Moved to `owned/accepted`: <yes/no> |
| Plex friend | <yes/no, from api/users and Jordan's look at Plex Web> |
| Sign-in with the test account | WebServarr <let it in / refused>; Authentik <created the account / ...> |
| Removed | By Jordan in Plex, <date> |
```

- [ ] **Step 10: Commit and push**

```bash
git add docs/superpowers/specs/2026-10-10-request-access-design.md
git commit -m "docs(spec): record the Plex share proof for request access"
```
Then the deploy sequence from Global Constraints (no dev pull or restart needed for docs).

### Task 2: Authentik enrollment check, read-only (Jordan gate if needed)

The spec's open risk 2: Authentik's Plex source must create an account for a newly shared Plex user on their first sign-in, and its server check must pass once the invite is accepted. Change nothing in Authentik.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-10-request-access-design.md` (section 13, risk 2: the answer).

**Interfaces:** none for code. If the answer is "no", the plan stops.

- [ ] **Step 1: Read what the repo says**

Read `docs/authentik.md` Steps 1 and 5 (the Plex source's fields; the application). Note what a correct setup needs: an enrollment flow on the Plex source, the server ticked under Allowed servers, Allow friends off, and no binding on the WebServarr application that would keep a new user out.

- [ ] **Step 2: Decide whether the agent can check it**

The agent has no Authentik admin API token, and must not look for one (no reading of `.env` files, the database or container environments for it). So ask Jordan to check one screen:

"Waiting on you: one read-only look in Authentik, please. Directory > Federation and Social login > your Plex source > Edit. Tell me: (1) Enrollment flow: which flow is set (or is it empty)? (2) User matching mode. (3) Allowed servers: is your server ticked? (4) Allow friends: on or off? And on Applications > Applications > WebServarr, the Policy / Group / User Bindings tab: is it empty, or bound to a group? Change nothing."

If Task 1 Step 8 has already run, its sign-in result is the live answer; still record the screen's settings.

- [ ] **Step 3: Record the answer**

Replace risk 2's last sentence in section 13 with what Jordan reported, for example:

```markdown
   Checked <date> (read-only, by Jordan): enrollment flow <name>, user matching <mode>, the server is
   ticked under Allowed servers, Allow friends <off>, the WebServarr application <has no bindings / is bound
   to group X>. <Task 1's sign-in with the test account: Authentik created the account and let it in.>
```

If enrollment is empty, or the application is bound to a group a new user would not be in, stop the plan and report to Jordan: approving a request would share Plex with someone who still can't sign in.

- [ ] **Step 4: Commit and push**

```bash
git add docs/superpowers/specs/2026-10-10-request-access-design.md
git commit -m "docs(spec): record the Authentik enrollment check for request access"
```
Then the deploy sequence (docs only, no dev pull).

### Task 3: Mockup of the card and the admin tab (Jordan gate for Tasks 9 and 10)

Jordan's rule: no unreviewed visual redesign. One static page shows every card state inside the existing frosted sign-in card, at 390 and 1440 wide, plus the Settings tab. Tasks 9 and 10 do not start until Jordan approves it.

**Files:**
- Create: `docs/mockups/request-access.html` (self-contained: no app CSS, so it renders as an artifact too).

**Interfaces:**
- Produces for Tasks 9 and 10: the approved look. The element ids and `data-ra-*` hooks in Task 9 and the card titles in Task 10 are fixed by this plan; the mockup decides only classes, spacing and wording polish. If Jordan changes wording, the new words go into Tasks 9 and 10 and the spec in the same change.

- [ ] **Step 1: Build the mockup**

Write one HTML file that:
- Uses the shipped default theme tokens as CSS variables (copy the `:root` colour block and the frost recipe from `app/static/css/theme.css`: `--ws-frost-*` with their defaults) and `.login-glass-card` from `app/static/login.html`, over a dark gradient that stands in for the artwork. Tailwind may come from the Play CDN with the same colour names as `docs/mockups/metric-options.html`.
- Shows two columns of frames, one 390 px wide and one 1440 px wide (the 1440 one at reduced scale is fine), each holding the card at the centre position, plus one 1440 frame with the card left and one with it right.
- In each frame, draws the card as it looks in each state, labelled above the frame: S0 sign in with the "New here? Request access" link under the buttons; S1 intro; S2 waiting, and S2 with the "Your browser blocked the Plex window" error; S3 form with a 40 px avatar, "Requesting as <username>", the name field, the textarea with its 0/1000 counter, an inline error line; S4 sent; S5 each of pending, approved (same as invited), denied, blocked and member. Use exactly the words in spec section 9.
- Draws the Settings tab at 390 and 1440: the tab strip with "Access requests" and a count badge of 3; the switch card (with the "needs Plex" note variant); default libraries as checkboxes; two waiting request cards (one with a long note with line breaks and one 200-character word to show wrapping); the Approve dialog with library checkboxes; the Deny dialog with "Block this Plex account for good"; the Decided list with an approved row whose share failed (Plex's reason and "Share it in Plex yourself"), a denied row and a blocked row with Unblock.

- [ ] **Step 2: Publish it and check it at both widths**

Publish the file with the Artifact tool (load the `artifact-design` skill first, as that tool requires; the mockup's own look follows the app, not the skill's defaults). Look at the published page at phone and desktop width: every state is labelled, the words match spec section 9, and nothing overflows horizontally in the 390 frames.

- [ ] **Step 3: Ask Jordan**

Send Jordan the link: "Waiting on you: the request access mockup (every card state at 390 and 1440, and the Settings tab). Tasks 9 and 10 wait for your OK; backend work continues meanwhile."

- [ ] **Step 4: Commit the mockup**

```bash
git add docs/mockups/request-access.html
git commit -m "docs(mockup): request access card states and the Settings tab"
```
Then the deploy sequence (docs only). When Jordan approves (or asks for changes and then approves), commit any revision the same way and record "Approved by Jordan <date>" in an HTML comment at the top of the file.

### Task 4: Data model, settings keys, branding flag and tidy

**Files:**
- Modify: `app/models.py` (add `AccessRequest` after `Notification`)
- Modify: `app/settings_registry.py` (two keys after the Sign-in group; `_validate_library_keys`; one branch in `validate_value`)
- Modify: `app/routers/branding.py` (`auth_methods.request_access`)
- Create: `app/services/access_requests.py`
- Modify: `app/services/notification_poller.py` (hourly tidy in `_poll_forever`)
- Test: `app/tests/test_access_requests_model.py`

**Interfaces:**
- Produces (used by Tasks 6 to 8):
  - `AccessRequest` model, table `access_requests`, columns exactly as spec section 4.
  - `svc.now_utc() -> datetime` (naive UTC)
  - `svc.is_open(db) -> bool`
  - `svc.safe_avatar_url(value) -> str`
  - `svc.clean_form(name: str, note: str) -> tuple[str, str]`, raising `svc.FormProblem(message)`
  - `svc.state_for(db, plex_account_id: str, now) -> dict` with `state` in `new|pending|approved|denied|blocked`, plus `submitted_at`, and `can_ask_after` for denied
  - `svc.place(db, account: dict, name: str, note: str, now) -> tuple[dict, AccessRequest | None]`, raising `svc.CapReached`; `account` keys: `plex_account_id`, `plex_username`, `plex_email`, `plex_avatar_url`
  - `svc.tidy(db, now) -> int`
  - Constants `COOLDOWN`, `APPROVED_KEPT`, `OPEN_CAP = 20`, `TIDY_INTERVAL = 3600`, `NAME_MAX = 80`, `NOTE_MAX = 1000`, `NAME_PROBLEM`, `NOTE_PROBLEM`
  - Branding: `auth_methods["request_access"]: bool`

- [ ] **Step 1: Write the failing tests**

Create `app/tests/test_access_requests_model.py`:

```python
"""
Request access, the database half (docs/superpowers/specs/2026-10-10-request-access-design.md,
sections 4 and 5): the two settings and their checks, the sign-in page's flag, the server-side gate,
the form rules, the per-account state, the submit rules (blocked, cooldown, one open request, the cap
of 20) and the tidy.
"""
import inspect
import json
import unittest
from datetime import timedelta

try:
    import sqlalchemy  # noqa: F401
    from fastapi import FastAPI  # noqa: F401
    HAVE_APP = True
except ImportError:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

if HAVE_APP:
    from app import settings_registry as reg
    from app.models import AccessRequest
    from app.routers import branding
    from app.services import access_requests as svc
    from app.services import notification_poller
    from app.tests import helpers

ACCOUNT = {"plex_account_id": "5551", "plex_username": "newperson", "plex_email": "new@example.com",
           "plex_avatar_url": "https://plex.tv/users/abc/avatar?c=1"}


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class SettingsKeys(unittest.TestCase):
    def test_the_switch_is_off_by_default_and_public(self):
        d = reg.REGISTRY["access_requests.enabled"]
        self.assertEqual((d.type, d.default, d.public, d.secret), ("bool", "false", True, False))
        self.assertIn("access_requests.enabled", reg.seed_defaults())

    def test_default_libraries_is_a_private_list_of_section_keys(self):
        key = "access_requests.default_libraries"
        d = reg.REGISTRY[key]
        self.assertEqual((d.type, d.default, d.public, d.max_length), ("json", "[]", False, 2000))
        for good in ('[]', '["1"]', '["1", "22", "4096"]', '["1234567890"]'):
            self.assertIsNone(reg.validate_value(key, good), good)
        for bad in ('{}', '"1"', '[1]', '["a"]', '["1x"]', '["12345678901"]', '["1", "1"]', '["-1"]',
                    'not json', '[" 1"]', '["١"]', ''):
            self.assertIsNotNone(reg.validate_value(key, bad), bad)
        too_long = json.dumps([str(1000000 + i) for i in range(250)])
        self.assertGreater(len(too_long), 2000)
        self.assertIsNotNone(reg.validate_value(key, too_long))


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class BrandingFlag(unittest.TestCase):
    def flag(self, enabled, url="http://192.168.1.2:32400", token="t"):
        values = {} if enabled is None else {"access_requests.enabled": enabled}
        auth = {"integration.plex.url": url, "integration.plex.token": token}
        payload = branding.build_branding(values, auth, None, dict(branding.EMPTY_WIKI_HOOKS))
        return payload["auth_methods"]["request_access"]

    def test_on_only_with_the_switch_and_plex(self):
        self.assertIs(self.flag(None), False)
        self.assertIs(self.flag("false"), False)
        self.assertIs(self.flag("true"), True)
        self.assertIs(self.flag("true", url=""), False)
        self.assertIs(self.flag("true", token=""), False)


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class WithDatabase(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.addCleanup(self.db.close)
        self.now = svc.now_utc().replace(microsecond=0)

    def row(self, account_id, status, created_at=None, **kw):
        r = AccessRequest(plex_account_id=account_id, plex_username="u" + account_id, name="N", note="n",
                          status=status, created_at=created_at or self.now, **kw)
        self.db.add(r)
        self.db.commit()
        return r

    def count(self, **filters):
        return self.db.query(AccessRequest).filter_by(**filters).count()


class Gate(WithDatabase):
    def test_open_only_with_the_switch_the_address_and_the_token(self):
        self.assertFalse(svc.is_open(self.db))
        helpers.put(self.db, "access_requests.enabled", "true")
        self.assertFalse(svc.is_open(self.db))
        helpers.put(self.db, "integration.plex.url", "http://192.168.1.2:32400")
        self.assertFalse(svc.is_open(self.db))
        helpers.put(self.db, "integration.plex.token", "t")
        self.assertTrue(svc.is_open(self.db))
        helpers.put(self.db, "access_requests.enabled", "false")
        self.assertFalse(svc.is_open(self.db))


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class Avatar(unittest.TestCase):
    def test_only_https_plex_tv_hosts(self):
        for good in ("https://plex.tv/users/abc/avatar?c=1", "https://assets.plex.tv/a.png",
                     "HTTPS://Plex.TV/users/x"):
            self.assertEqual(svc.safe_avatar_url(good), good, good)
        for bad in ("http://plex.tv/users/abc/avatar", "https://plex.tv.evil.example/x", "https://evilplex.tv/x",
                    "javascript:alert(1)", "", None, 7, "https://user@plex.tv/x", "https://plex.tv/a b",
                    "https://plex.tv/" + "a" * 500, "//plex.tv/x", "https://plex.tv:99999/x"):
            self.assertEqual(svc.safe_avatar_url(bad), "", repr(bad))


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class Form(unittest.TestCase):
    def test_trimmed_and_kept(self):
        self.assertEqual(svc.clean_form("  Sam Lee ", " Friend of Ana.\r\nWe met at work. "),
                         ("Sam Lee", "Friend of Ana.\nWe met at work."))
        self.assertEqual(svc.clean_form("Zoë 🎬", "x" * 1000), ("Zoë 🎬", "x" * 1000))

    def test_refused(self):
        cases = [("", "note", svc.NAME_PROBLEM), ("   ", "note", svc.NAME_PROBLEM),
                 ("n" * 81, "note", svc.NAME_PROBLEM), ("Sam\tLee", "note", svc.NAME_PROBLEM),
                 ("Sam\nLee", "note", svc.NAME_PROBLEM), ("Sam", "", svc.NOTE_PROBLEM),
                 ("Sam", "x" * 1001, svc.NOTE_PROBLEM), ("Sam", "bell\x07", svc.NOTE_PROBLEM),
                 ("Sam", "c1\x85", svc.NOTE_PROBLEM), ("Sam", "tab\tinside", svc.NOTE_PROBLEM)]
        for name, note, message in cases:
            with self.subTest(name=name[:10], note=note[:10]):
                with self.assertRaises(svc.FormProblem) as caught:
                    svc.clean_form(name, note)
                self.assertEqual(str(caught.exception), message)


class States(WithDatabase):
    def test_each_state(self):
        self.assertEqual(svc.state_for(self.db, "1", self.now), {"state": "new"})
        self.row("2", "pending")
        self.assertEqual(svc.state_for(self.db, "2", self.now)["state"], "pending")
        self.assertTrue(svc.state_for(self.db, "2", self.now)["submitted_at"].endswith("Z"))
        self.row("3", "approved", decided_at=self.now)
        self.assertEqual(svc.state_for(self.db, "3", self.now)["state"], "approved")
        self.row("4", "denied", decided_at=self.now, cooldown_until=self.now + timedelta(days=30))
        denied = svc.state_for(self.db, "4", self.now)
        self.assertEqual(denied["state"], "denied")
        self.assertTrue(denied["can_ask_after"].startswith(str((self.now + timedelta(days=30)).date())))
        self.row("5", "blocked", decided_at=self.now)
        self.assertEqual(svc.state_for(self.db, "5", self.now)["state"], "blocked")

    def test_a_cooldown_that_ended_reads_as_new(self):
        self.row("6", "denied", decided_at=self.now - timedelta(days=31), cooldown_until=self.now - timedelta(days=1))
        self.assertEqual(svc.state_for(self.db, "6", self.now), {"state": "new"})


class Place(WithDatabase):
    def place(self, account=None):
        return svc.place(self.db, account or ACCOUNT, "New Person", "A friend of Sam.", self.now)

    def test_a_new_account_gets_a_pending_row(self):
        result, row = self.place()
        self.assertEqual(result, {"state": "pending", "sent": True})
        self.assertEqual((row.status, row.plex_account_id, row.plex_username, row.name, row.note),
                         ("pending", "5551", "newperson", "New Person", "A friend of Sam."))
        self.assertEqual(row.plex_avatar_url, "https://plex.tv/users/abc/avatar?c=1")

    def test_an_unsafe_avatar_is_stored_empty(self):
        _, row = self.place({**ACCOUNT, "plex_avatar_url": "http://evil.example/a.png"})
        self.assertEqual(row.plex_avatar_url, "")

    def test_one_open_request_per_account(self):
        self.place()
        result, row = self.place()
        self.assertIsNone(row)
        self.assertEqual((result["state"], result["sent"]), ("pending", False))
        self.assertEqual(self.count(plex_account_id="5551"), 1)

    def test_approved_blocked_and_cooldown_answer_with_their_state(self):
        for status, extra in (("approved", {"decided_at": self.now}),
                              ("blocked", {"decided_at": self.now}),
                              ("denied", {"decided_at": self.now, "cooldown_until": self.now + timedelta(days=3)})):
            with self.subTest(status):
                self.db.query(AccessRequest).delete()
                self.db.commit()
                self.row("5551", status, **extra)
                result, row = self.place()
                self.assertIsNone(row)
                self.assertEqual((result["state"], result["sent"]), (status, False))
                self.assertEqual(self.count(), 1)

    def test_a_denied_row_whose_cooldown_ended_is_replaced(self):
        self.row("5551", "denied", decided_at=self.now - timedelta(days=31), cooldown_until=self.now - timedelta(seconds=1))
        result, row = self.place()
        self.assertEqual(result, {"state": "pending", "sent": True})
        self.assertEqual(self.count(plex_account_id="5551"), 1)
        self.assertEqual(row.status, "pending")

    def test_the_cap_counts_pending_only(self):
        for i in range(svc.OPEN_CAP):
            self.row(str(9000 + i), "approved", decided_at=self.now)
        self.assertEqual(self.place()[0]["sent"], True)

    def test_the_cap_refuses_the_twenty_first_and_keeps_an_old_denied_row(self):
        for i in range(svc.OPEN_CAP):
            self.row(str(9000 + i), "pending")
        self.row("5551", "denied", decided_at=self.now - timedelta(days=31), cooldown_until=self.now - timedelta(days=1))
        with self.assertRaises(svc.CapReached):
            self.place()
        self.assertEqual(self.count(plex_account_id="5551", status="denied"), 1)
        self.assertEqual(self.count(status="pending"), svc.OPEN_CAP)


class Tidy(WithDatabase):
    def test_what_goes_and_what_stays(self):
        day = timedelta(days=1)
        self.row("1", "denied", decided_at=self.now - 31 * day, cooldown_until=self.now - day)        # goes
        self.row("2", "denied", decided_at=self.now - day, cooldown_until=self.now + 29 * day)        # stays
        self.row("3", "approved", decided_at=self.now - 31 * day)                                     # goes
        self.row("4", "approved", decided_at=self.now - 29 * day)                                     # stays
        self.row("5", "blocked", decided_at=self.now - 400 * day)                                     # stays
        self.row("6", "pending", created_at=self.now - 400 * day)                                     # stays
        self.assertEqual(svc.tidy(self.db, self.now), 2)
        left = sorted(r.plex_account_id for r in self.db.query(AccessRequest).all())
        self.assertEqual(left, ["2", "4", "5", "6"])

    def test_the_leader_loop_tidies_hourly(self):
        src = inspect.getsource(notification_poller._poll_forever)
        self.assertIn("access_requests.tidy(", src)
        self.assertIn("access_requests.TIDY_INTERVAL", src)
        self.assertEqual(svc.TIDY_INTERVAL, 3600)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run them and see them fail**

Run: `ssh webserver "docker exec -i webservarr-dev python - -v" < app/tests/test_access_requests_model.py`
Expected: an import error for `AccessRequest` (or `app.services.access_requests`): the module does not exist yet.

- [ ] **Step 3: Add the model**

In `app/models.py`, after the `Notification` class:

```python
class AccessRequest(Base):
    """A stranger's request for access from the sign-in page, one row per Plex
    account (docs/superpowers/specs/2026-10-10-request-access-design.md,
    section 4). The Plex account id is the key for "one open request" and
    for the cooldown. The requester's Plex token is never stored anywhere.
    app/services/access_requests.py owns the rules."""

    __tablename__ = "access_requests"

    id = Column(Integer, primary_key=True, index=True)
    plex_account_id = Column(String(32), unique=True, nullable=False)
    plex_username = Column(String(100), nullable=False)
    plex_email = Column(String(254), nullable=False, default="", server_default="")
    plex_avatar_url = Column(String(500), nullable=False, default="", server_default="")
    name = Column(String(80), nullable=False)
    note = Column(Text, nullable=False)
    status = Column(String(10), nullable=False, index=True)    # pending, approved, denied, blocked
    share_state = Column(String(10), nullable=True)             # shared, existing, failed (set on approve)
    share_error = Column(String(200), nullable=True)            # Plex's short reason when failed, never a token
    library_keys = Column(Text, nullable=True)                  # JSON list of the section keys ticked on approve
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    decided_at = Column(DateTime, nullable=True)
    decided_by = Column(String(64), nullable=True)              # the admin's tickets.account_identity
    cooldown_until = Column(DateTime, nullable=True)            # denied: decided_at plus 30 days
```

- [ ] **Step 4: Add the settings keys**

In `app/settings_registry.py`, inside `_build()`, right after the `system.admin_email` entry (end of the Sign-in group):

```python
        # ---- Access requests (Settings > Access requests) ----
        # Off by default. Public, but the sign-in page reads only the
        # branding flag auth_methods.request_access, which also needs Plex.
        _bool("access_requests.enabled", "false", "Let people request access from the sign-in page", public=True),
        # The Plex library section keys ("1", "4", ...) ticked for a new
        # person when the admin approves them (_validate_library_keys).
        SettingDef("access_requests.default_libraries", "[]", "json",
                   "Libraries a new person gets when you approve them", max_length=2000, allow_empty=False),
```

After `_validate_page_order`, add:

```python
_LIBRARY_KEY = re.compile(r"[0-9]{1,10}")   # ASCII digits only, as _INT


def _validate_library_keys(v: str) -> Optional[str]:
    """access_requests.default_libraries: a JSON list of distinct Plex section keys."""
    try:
        items = json.loads(v)
    except ValueError:
        return "Not valid JSON"
    if not isinstance(items, list) or not all(isinstance(i, str) and _LIBRARY_KEY.fullmatch(i) for i in items):
        return "Pick libraries from the list"
    if len(set(items)) != len(items):
        return "Pick each library once"
    return None
```

In `validate_value`, in the `if d.type == "json":` branch, before `try: json.loads(value)`:

```python
        if d.key == "access_requests.default_libraries":
            return _validate_library_keys(value)
```

- [ ] **Step 5: Add the branding flag**

In `app/routers/branding.py` `build_branding`, extend the `auth_methods` dict:

```python
    auth_methods = {
        "simple": get("features.show_simple_auth") != "false",
        "plex": get("features.show_plex_auth") != "false" and bool(plex_url and plex_token),
        "authentik": get("features.show_authentik_auth") == "true" and bool(authentik_url and authentik_client_id),
        # The sign-in page's "New here? Request access" link. The same rule
        # as the request routes' own gate (services/access_requests.is_open).
        "request_access": get("access_requests.enabled") == "true" and bool(plex_url and plex_token),
    }
```

- [ ] **Step 6: Write the service module**

Create `app/services/access_requests.py`:

```python
"""
Request access from the sign-in page: the rules that live in the database
(docs/superpowers/specs/2026-10-10-request-access-design.md, sections 4 to 6).

The router (app/routers/access_requests.py) talks to Plex and Redis and
holds the submit lock; this module decides. Times are naive UTC, as every
stored timestamp is.
"""
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional, Tuple
from urllib.parse import urlsplit

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import AccessRequest, Setting
from app.utils import utc_iso

COOLDOWN = timedelta(days=30)        # a denied account may ask again after this
APPROVED_KEPT = timedelta(days=30)   # approved rows are tidied away after this
OPEN_CAP = 20                        # pending requests at once, across everyone
TIDY_INTERVAL = 3600                 # seconds between tidies, in the poller's leader loop
NAME_MAX = 80
NOTE_MAX = 1000
AVATAR_MAX = 500
NAME_PROBLEM = "Enter your name (up to 80 characters)."
NOTE_PROBLEM = "Tell us who you are and how you know us (up to 1000 characters)."


class FormProblem(ValueError):
    """The form can't be taken; the text says why, in the card's words."""


class CapReached(Exception):
    """OPEN_CAP requests are already waiting."""


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _setting(db: Session, key: str, default: str = "") -> str:
    row = db.query(Setting).filter(Setting.key == key).first()
    return row.value if row is not None and row.value is not None else default


def is_open(db: Session) -> bool:
    """The server-side gate: the switch is on and Plex is set up. The same
    rule as the branding flag auth_methods.request_access."""
    return (_setting(db, "access_requests.enabled", "false") == "true"
            and bool(_setting(db, "integration.plex.url"))
            and bool(_setting(db, "integration.plex.token")))


def safe_avatar_url(value) -> str:
    """The Plex avatar as it may be stored and shown: https on plex.tv or a
    subdomain of it, with no credentials in it, else ""."""
    if not isinstance(value, str):
        return ""
    v = value.strip()
    if not v or len(v) > AVATAR_MAX or any(c.isspace() or c == "\\" for c in v):
        return ""
    try:
        parts = urlsplit(v)
        host = (parts.hostname or "").lower()
        _ = parts.port   # a port past 65535 raises here
    except ValueError:
        return ""
    if parts.scheme.lower() != "https" or parts.username is not None or parts.password is not None:
        return ""
    return v if host == "plex.tv" or host.endswith(".plex.tv") else ""


def _has_control(text: str, newline_ok: bool) -> bool:
    return any(unicodedata.category(c) == "Cc" and not (newline_ok and c == "\n") for c in text)


def clean_form(name: str, note: str) -> Tuple[str, str]:
    """The form as stored: both trimmed, the note's line ends as \\n. Control
    characters are refused, except newlines in the note."""
    name = name.strip()
    note = note.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not name or len(name) > NAME_MAX or _has_control(name, newline_ok=False):
        raise FormProblem(NAME_PROBLEM)
    if not note or len(note) > NOTE_MAX or _has_control(note, newline_ok=True):
        raise FormProblem(NOTE_PROBLEM)
    return name, note


def _row(db: Session, plex_account_id: str) -> Optional[AccessRequest]:
    return db.query(AccessRequest).filter(AccessRequest.plex_account_id == str(plex_account_id)).first()


def _cooled_down(row: AccessRequest, now: datetime) -> bool:
    return row.status == "denied" and row.cooldown_until is not None and row.cooldown_until <= now


def _state_of(row: AccessRequest) -> Dict[str, str]:
    out = {"state": row.status, "submitted_at": utc_iso(row.created_at)}
    if row.status == "denied":
        out["can_ask_after"] = utc_iso(row.cooldown_until)
    return out


def state_for(db: Session, plex_account_id: str, now: datetime) -> Dict[str, str]:
    """What the card says to this account from its row: new (no row, or a
    cooldown that has ended), pending, approved, denied (with can_ask_after)
    or blocked."""
    row = _row(db, plex_account_id)
    if row is None or _cooled_down(row, now):
        return {"state": "new"}
    return _state_of(row)


def place(db: Session, account: Dict[str, str], name: str, note: str,
          now: datetime) -> Tuple[Dict, Optional[AccessRequest]]:
    """Submit's checks and insert, in the spec's order: blocked, cooldown, an
    open request (pending or approved), then the cap. The caller holds the
    submit lock, so two workers can't both pass the cap. Returns the answer
    for the card and the new row (None when nothing was made). Raises
    CapReached when OPEN_CAP requests are already waiting."""
    row = _row(db, account["plex_account_id"])
    if row is not None and _cooled_down(row, now):
        db.delete(row)       # the person may ask again: the new row replaces it
        db.flush()
        row = None
    if row is not None:
        return {**_state_of(row), "sent": False}, None
    if db.query(AccessRequest).filter(AccessRequest.status == "pending").count() >= OPEN_CAP:
        db.rollback()        # puts back a denied row deleted above
        raise CapReached()
    new = AccessRequest(
        plex_account_id=str(account["plex_account_id"]),
        plex_username=str(account.get("plex_username") or "")[:100],
        plex_email=str(account.get("plex_email") or "")[:254],
        plex_avatar_url=safe_avatar_url(account.get("plex_avatar_url")),
        name=name, note=note, status="pending", created_at=now,
    )
    db.add(new)
    try:
        db.commit()
    except IntegrityError:   # the same account, inserted a moment ago
        db.rollback()
        existing = _row(db, account["plex_account_id"])
        return ({**_state_of(existing), "sent": False} if existing else {"state": "new", "sent": False}), None
    db.refresh(new)
    return {"state": "pending", "sent": True}, new


def tidy(db: Session, now: datetime) -> int:
    """Delete denied rows whose cooldown has ended and approved rows decided
    more than APPROVED_KEPT ago. Blocked and pending rows stay. Returns how
    many rows went."""
    gone = (db.query(AccessRequest)
            .filter(AccessRequest.status == "denied", AccessRequest.cooldown_until.isnot(None),
                    AccessRequest.cooldown_until <= now)
            .delete(synchronize_session=False))
    gone += (db.query(AccessRequest)
             .filter(AccessRequest.status == "approved", AccessRequest.decided_at.isnot(None),
                     AccessRequest.decided_at <= now - APPROVED_KEPT)
             .delete(synchronize_session=False))
    db.commit()
    return gone
```

- [ ] **Step 7: Tidy hourly in the leader loop**

In `app/services/notification_poller.py`, add to the imports: `from app.services import access_requests`. In `_poll_forever`, next to `last_library = 0.0`:

```python
    # Access requests: denied rows past their cooldown and approved rows
    # after 30 days go once an hour (services/access_requests.tidy).
    last_access_tidy = -access_requests.TIDY_INTERVAL
```

and inside the `try:` of the loop, after the library lines block:

```python
            # --- Access requests: the hourly tidy ---
            if lease.held and now - last_access_tidy >= access_requests.TIDY_INTERVAL:
                last_access_tidy = now
                tidy_db = SessionLocal()
                try:
                    access_requests.tidy(tidy_db, access_requests.now_utc())
                except Exception as exc:
                    logger.warning("Poller: access request tidy failed: %s", type(exc).__name__)
                finally:
                    tidy_db.close()
```

- [ ] **Step 8: Commit**

```bash
git add app/models.py app/settings_registry.py app/routers/branding.py app/services/access_requests.py app/services/notification_poller.py app/tests/test_access_requests_model.py
git commit -m "feat(access): the access requests table, its settings, the sign-in flag and the hourly tidy"
```

- [ ] **Step 9: Deploy to dev and run the tests**

Deploy sequence from Global Constraints, including `docker restart webservarr-dev`. Then:
Run: `ssh webserver "docker exec webservarr-dev python -m unittest app.tests.test_access_requests_model -v"`
Expected: all pass. Then run the full suite (command in Global Constraints); expected: `OK`, no failures, no skips. Fix anything red with a new commit and push again. Watch CI green.

### Task 5: Plex share client

**Files:**
- Create: `app/integrations/plex_share.py`
- Test: `app/tests/test_plex_share.py`

**Interfaces:**
- Consumes from Task 1: the proven create route and the listing shape. The code below is route A with listings as JSON lists of entries carrying `invitedId` and `machineIdentifier`. If Task 1 recorded route B, replace `_create` with the route B version given in Step 4. If Task 1 recorded that the entry names the account by a different field than `invitedId`, change `_find`'s comparison to that field and say so in the commit message.
- Produces (used by Tasks 7 and 8):
  - `class PlexShareUnavailable(Exception)`: its text is safe to show to the admin.
  - `async list_libraries() -> list[dict]`: `[{"key": str, "title": str, "type": str}]`; raises `PlexShareUnavailable`.
  - `async find_share(plex_account_id: str) -> "accepted" | "pending" | None`; raises `PlexShareUnavailable`.
  - `async share_server(account: dict, section_keys: list[str]) -> tuple[str, str | None]`: `("existing", None)`, `("shared", None)` or `("failed", reason)`; never raises for Plex trouble. `account` keys: `plex_account_id`, `plex_username`.

- [ ] **Step 1: Write the failing tests**

Create `app/tests/test_plex_share.py`:

```python
"""
The Plex share client (spec section 7), against a fake plex.tv on an
httpx.MockTransport. Any call the fake doesn't expect fails the test, so the
client can never reach the real plex.tv here.
"""
import asyncio
import json
import unittest
from unittest import mock

try:
    import httpx  # noqa: F401
    from fastapi import FastAPI  # noqa: F401
    HAVE_APP = True
except ImportError:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

if HAVE_APP:
    import httpx
    from app.integrations import plex_share
    from app.tests import helpers

ADMIN_TOKEN = "ADMIN-TOKEN-SENTINEL-77"
MID = "machine-1"
ACCOUNT = {"plex_account_id": "5551", "plex_username": "newperson"}
SECTIONS = {"librarySections": [{"id": 901, "key": "1", "title": "Movies", "type": "movie"},
                                {"id": 902, "key": "2", "title": "TV", "type": "show"}]}
CREATE = f"https://plex.tv/api/servers/{MID}/shared_servers"


class FakePlex:
    """plex.tv as far as the client uses it. A POST that succeeds adds the
    share to the pending list (unless confirm is False)."""

    def __init__(self, accepted=(), pending=(), post_status=201, confirm=True, post_error=None, listing_status=200):
        self.accepted, self.pending = list(accepted), list(pending)
        self.post_status, self.confirm, self.post_error = post_status, confirm, post_error
        self.listing_status = listing_status
        self.calls, self.posted = [], []

    def handler(self, request):
        url = str(request.url)
        self.calls.append((request.method, url, request.headers.get("x-plex-token")))
        if request.method == "GET" and url == f"https://plex.tv/api/v2/servers/{MID}":
            return httpx.Response(200, json=SECTIONS)
        if request.method == "GET" and url == "https://clients.plex.tv/api/v2/shared_servers/owned/accepted":
            return httpx.Response(self.listing_status, json=self.accepted)
        if request.method == "GET" and url == "https://clients.plex.tv/api/v2/shared_servers/owned/pending":
            return httpx.Response(self.listing_status, json=self.pending)
        if request.method == "POST" and url == CREATE:
            self.posted.append(json.loads(request.content))
            if self.post_error:
                raise self.post_error
            if self.post_status in (200, 201) and self.confirm:
                self.pending.append({"invitedId": 5551, "machineIdentifier": MID, "inviteToken": "INVITE-SECRET"})
            return httpx.Response(self.post_status, json={"inviteToken": "INVITE-SECRET", "id": 1})
        raise AssertionError(f"unexpected Plex call: {request.method} {url}")


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class ShareClient(unittest.TestCase):
    def use(self, plex):
        self.plex = plex
        server = plex_share.PlexServer(MID, {"Accept": "application/json", "X-Plex-Token": ADMIN_TOKEN})
        for p in (mock.patch.object(plex_share, "_server", mock.AsyncMock(return_value=server)),
                  mock.patch.object(plex_share, "_client", lambda: httpx.AsyncClient(
                      transport=httpx.MockTransport(plex.handler), timeout=plex_share.TIMEOUT))):
            p.start()
            self.addCleanup(p.stop)
        return plex

    def share(self, keys=("1",)):
        return asyncio.run(plex_share.share_server(dict(ACCOUNT), list(keys)))

    def posts(self):
        return [c for c in self.plex.calls if c[0] == "POST"]

    def test_an_existing_share_means_no_post(self):
        for where in ("accepted", "pending"):
            with self.subTest(where):
                entry = {"invitedId": 5551, "machineIdentifier": MID}
                self.use(FakePlex(**{where: [entry]}))
                self.assertEqual(self.share(), ("existing", None))
                self.assertEqual(self.posts(), [])

    def test_a_share_for_another_server_or_account_is_not_existing(self):
        self.use(FakePlex(accepted=[{"invitedId": 5551, "machineIdentifier": "other"},
                                    {"invitedId": 1, "machineIdentifier": MID}]))
        self.assertEqual(self.share(), ("shared", None))
        self.assertEqual(len(self.posts()), 1)

    def test_shared_sends_what_python_plexapi_sends_and_is_confirmed(self):
        self.use(FakePlex())
        self.assertEqual(self.share(("1", "2")), ("shared", None))
        self.assertEqual(self.plex.posted, [{
            "server_id": MID,
            "shared_server": {"library_section_ids": [901, 902], "invited_email": "newperson"},
            "sharing_settings": {"allowSync": "0", "allowCameraUpload": "0", "allowChannels": "0",
                                 "filterMovies": "", "filterTelevision": "", "filterMusic": ""},
        }])
        for method, url, token in self.plex.calls:
            self.assertEqual(token, ADMIN_TOKEN, url)
            self.assertNotIn(ADMIN_TOKEN, url)

    def test_a_refusal_is_failed_with_the_status_and_never_retried(self):
        for status in (400, 401, 422, 500, 503):
            with self.subTest(status):
                self.use(FakePlex(post_status=status))
                self.assertEqual(self.share(), ("failed", f"Plex refused the share (HTTP {status})"))
                self.assertEqual(len(self.posts()), 1)

    def test_no_confirming_listing_is_failed(self):
        self.use(FakePlex(confirm=False))
        self.assertEqual(self.share(), ("failed", "Plex didn't confirm the share"))

    def test_a_dropped_post_is_failed_once(self):
        self.use(FakePlex(post_error=httpx.ConnectError("down")))
        self.assertEqual(self.share(), ("failed", "Plex didn't answer the share"))
        self.assertEqual(len(self.posts()), 1)

    def test_a_library_no_longer_on_the_server_is_failed_without_a_post(self):
        self.use(FakePlex())
        self.assertEqual(self.share(("1", "77")), ("failed", "Those libraries aren't on the server any more"))
        self.assertEqual(self.posts(), [])

    def test_plex_not_configured_is_failed_with_its_reason(self):
        with mock.patch.object(plex_share, "_server",
                               mock.AsyncMock(side_effect=plex_share.PlexShareUnavailable("Plex isn't connected"))):
            self.assertEqual(asyncio.run(plex_share.share_server(dict(ACCOUNT), ["1"])),
                             ("failed", "Plex isn't connected"))

    def test_no_reason_carries_a_token(self):
        for plex in (FakePlex(post_status=400), FakePlex(confirm=False), FakePlex(listing_status=500)):
            self.use(plex)
            state, reason = self.share()
            self.assertEqual(state, "failed")
            self.assertNotIn(ADMIN_TOKEN, reason)
            self.assertNotIn("INVITE-SECRET", reason)
            self.assertLessEqual(len(reason), 200)

    def test_list_libraries(self):
        self.use(FakePlex())
        self.assertEqual(asyncio.run(plex_share.list_libraries()),
                         [{"key": "1", "title": "Movies", "type": "movie"}, {"key": "2", "title": "TV", "type": "show"}])

    def test_find_share(self):
        self.use(FakePlex(accepted=[{"invitedId": 5551, "machineIdentifier": MID}]))
        self.assertEqual(asyncio.run(plex_share.find_share("5551")), "accepted")
        self.use(FakePlex(pending=[{"invitedId": "5551", "machineIdentifier": MID}]))
        self.assertEqual(asyncio.run(plex_share.find_share("5551")), "pending")
        self.use(FakePlex())
        self.assertIsNone(asyncio.run(plex_share.find_share("5551")))
        self.use(FakePlex(listing_status=500))
        with self.assertRaises(plex_share.PlexShareUnavailable):
            asyncio.run(plex_share.find_share("5551"))


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class ServerContext(unittest.TestCase):
    """_server: the admin token and exactly one machine id, or a reason."""

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        p = mock.patch.object(plex_share, "SessionLocal", self.Session)
        p.start()
        self.addCleanup(p.stop)

    def test_no_token_is_not_connected(self):
        with mock.patch.object(plex_share.integration_config, "read", return_value={}):
            with self.assertRaises(plex_share.PlexShareUnavailable) as caught:
                asyncio.run(plex_share._server())
        self.assertEqual(str(caught.exception), "Plex isn't connected")

    def test_not_exactly_one_server_id(self):
        values = {"integration.plex.url": "http://192.168.1.2:32400", "integration.plex.token": ADMIN_TOKEN}
        for ids in (set(), {"a", "b"}):
            with self.subTest(ids=sorted(ids)), \
                 mock.patch.object(plex_share.integration_config, "read", return_value=values), \
                 mock.patch("app.routers.auth._fetch_configured_server_identifiers", mock.AsyncMock(return_value=ids)):
                with self.assertRaises(plex_share.PlexShareUnavailable):
                    asyncio.run(plex_share._server())

    def test_one_server_id(self):
        values = {"integration.plex.url": "http://192.168.1.2:32400", "integration.plex.token": ADMIN_TOKEN}
        with mock.patch.object(plex_share.integration_config, "read", return_value=values), \
             mock.patch("app.routers.auth._fetch_configured_server_identifiers", mock.AsyncMock(return_value={MID})):
            server = asyncio.run(plex_share._server())
        self.assertEqual(server.machine_id, MID)
        self.assertEqual(server.headers["X-Plex-Token"], ADMIN_TOKEN)
        self.assertIn("X-Plex-Client-Identifier", server.headers)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run them and see them fail**

Run: `ssh webserver "docker exec -i webservarr-dev python - -v" < app/tests/test_plex_share.py`
Expected: `ModuleNotFoundError: No module named 'app.integrations.plex_share'`.

- [ ] **Step 3: Write the client**

Create `app/integrations/plex_share.py`:

```python
"""
Share the configured Plex server with one Plex account, as the server's
owner (the admin token), for Settings > Access requests
(docs/superpowers/specs/2026-10-10-request-access-design.md, section 7).

Every call goes to a fixed plex.tv host with TLS verified, the admin token
in the X-Plex-Token header (never the query string) and the app's Plex
client headers. Each call times out after TIMEOUT seconds, and nothing is
retried, so a share is never POSTed twice. Plex's answers carry invite and
access tokens: only the fields named here are read out of them, and nothing
from them is logged or stored.

The create call is the one build task 1 proved (route A, the v1 invite that
python-plexapi's inviteFriend sends).
"""
import logging
from typing import Dict, List, NamedTuple, Optional, Tuple

import httpx

from app.database import SessionLocal
from app.integrations import config as integration_config

logger = logging.getLogger(__name__)

TIMEOUT = 10.0
PLEX_TV = "https://plex.tv"
CLIENTS = "https://clients.plex.tv"


class PlexShareUnavailable(Exception):
    """Plex isn't set up, didn't answer, or answered with something unusable.
    The text is safe to show to the admin: never a token."""


class PlexServer(NamedTuple):
    machine_id: str
    headers: Dict[str, str]   # the client headers plus the admin X-Plex-Token


async def _server() -> PlexServer:
    """The configured server's machine id and the headers every call sends."""
    # At call time: the auth router imports the app.
    from app.routers.auth import _fetch_configured_server_identifiers, _plex_client_headers

    values = integration_config.read([integration_config.url_key("plex"), integration_config.CREDENTIAL_KEYS["plex"]])
    token = integration_config.credential("plex", values)
    if not token or not integration_config.base_url("plex", values):
        raise PlexShareUnavailable("Plex isn't connected")
    db = SessionLocal()
    try:
        headers = {**_plex_client_headers(db), "X-Plex-Token": token}
        ids = await _fetch_configured_server_identifiers(db)
    finally:
        db.close()
    if len(ids) != 1:
        raise PlexShareUnavailable("Plex didn't say which server is yours")
    return PlexServer(next(iter(ids)), headers)


def _client() -> httpx.AsyncClient:
    """A client per call. The tests replace this with one on a MockTransport."""
    return httpx.AsyncClient(timeout=TIMEOUT)


async def _get_json(client: httpx.AsyncClient, url: str, server: PlexServer):
    try:
        resp = await client.get(url, headers=server.headers)
    except httpx.HTTPError as exc:
        raise PlexShareUnavailable("Plex didn't answer") from exc
    if resp.status_code != 200:
        raise PlexShareUnavailable(f"Plex answered HTTP {resp.status_code}")
    try:
        return resp.json()
    except ValueError as exc:
        raise PlexShareUnavailable("Plex sent something unreadable") from exc


async def _sections(client: httpx.AsyncClient, server: PlexServer) -> List[Dict[str, str]]:
    """[{id, key, title, type}], where id is plex.tv's section id (what the
    invite takes) and key the server's own section key (what Settings shows)."""
    data = await _get_json(client, f"{PLEX_TV}/api/v2/servers/{server.machine_id}", server)
    listed = data.get("librarySections") if isinstance(data, dict) else None
    out = []
    for s in listed if isinstance(listed, list) else []:
        if isinstance(s, dict) and s.get("id") is not None and s.get("key") is not None:
            out.append({"id": str(s["id"]), "key": str(s["key"]),
                        "title": str(s.get("title") or ""), "type": str(s.get("type") or "")})
    return out


async def _find(client: httpx.AsyncClient, server: PlexServer, plex_account_id: str) -> Optional[str]:
    for state in ("accepted", "pending"):
        data = await _get_json(client, f"{CLIENTS}/api/v2/shared_servers/owned/{state}", server)
        for entry in data if isinstance(data, list) else []:
            if (isinstance(entry, dict)
                    and str(entry.get("invitedId") or "") == str(plex_account_id)
                    and str(entry.get("machineIdentifier") or "") == server.machine_id):
                return state
    return None


async def list_libraries() -> List[Dict[str, str]]:
    """The server's libraries: [{key, title, type}]."""
    server = await _server()
    async with _client() as client:
        sections = await _sections(client, server)
    return [{"key": s["key"], "title": s["title"], "type": s["type"]} for s in sections]


async def find_share(plex_account_id: str) -> Optional[str]:
    """"accepted" or "pending" when the server is already shared with this
    account, else None."""
    server = await _server()
    async with _client() as client:
        return await _find(client, server, plex_account_id)


async def _create(client: httpx.AsyncClient, server: PlexServer, username: str, ids: List[str]) -> httpx.Response:
    """Route A: the v1 invite, with the body python-plexapi's inviteFriend sends."""
    body = {
        "server_id": server.machine_id,
        "shared_server": {"library_section_ids": [int(i) for i in ids], "invited_email": username},
        "sharing_settings": {"allowSync": "0", "allowCameraUpload": "0", "allowChannels": "0",
                             "filterMovies": "", "filterTelevision": "", "filterMusic": ""},
    }
    return await client.post(f"{PLEX_TV}/api/servers/{server.machine_id}/shared_servers",
                             json=body, headers=server.headers)


async def share_server(account: Dict[str, str], section_keys: List[str]) -> Tuple[str, Optional[str]]:
    """Share the server with account (plex_account_id, plex_username) and the
    libraries whose section keys are given. ("existing", None) when Plex
    already has a share for the account (no POST); ("shared", None) when
    Plex lists the new share for exactly this account; else ("failed",
    a short reason). Never raises for Plex trouble."""
    account_id = str(account["plex_account_id"])
    try:
        server = await _server()
        async with _client() as client:
            if await _find(client, server, account_id):
                return "existing", None
            by_key = {s["key"]: s["id"] for s in await _sections(client, server)}
            ids = [by_key[k] for k in section_keys if k in by_key]
            if not ids or len(ids) != len(section_keys):
                return "failed", "Those libraries aren't on the server any more"
            try:
                resp = await _create(client, server, str(account["plex_username"]), ids)
            except httpx.HTTPError:
                return "failed", "Plex didn't answer the share"
            if resp.status_code not in (200, 201):
                return "failed", f"Plex refused the share (HTTP {resp.status_code})"
            if await _find(client, server, account_id) is None:
                return "failed", "Plex didn't confirm the share"
            return "shared", None
    except PlexShareUnavailable as exc:
        return "failed", str(exc)[:200]
```

- [ ] **Step 4: Only if Task 1 proved route B instead**

Replace `_create` with:

```python
async def _create(client: httpx.AsyncClient, server: PlexServer, username: str, ids: List[str]) -> httpx.Response:
    """Route B: the v2 create (build task 1 found the v1 invite refused)."""
    body = {"machineIdentifier": server.machine_id, "librarySectionIds": [int(i) for i in ids],
            "invitedEmail": username,
            "settings": {"allowSync": False, "allowCameraUpload": False, "allowChannels": False}}
    return await client.post(f"{CLIENTS}/api/v2/shared_servers", json=body, headers=server.headers)
```

and in the test file change `CREATE` to `"https://clients.plex.tv/api/v2/shared_servers"` and the expected body in `test_shared_sends_what_python_plexapi_sends_and_is_confirmed` to that body (rename the test `test_shared_sends_the_v2_body_and_is_confirmed`). Update the module docstring's last paragraph to say route B.

- [ ] **Step 5: Commit**

```bash
git add app/integrations/plex_share.py app/tests/test_plex_share.py
git commit -m "feat(access): a Plex share client that shares the server once and confirms it"
```

- [ ] **Step 6: Deploy to dev and run the tests**

Deploy sequence with restart. Run: `ssh webserver "docker exec webservarr-dev python -m unittest app.tests.test_plex_share -v"`. Expected: all pass. Full suite green. CI green.

### Task 6: Admin contacts and the request notice

Spec section 8 as amended: the admin is found by the Plex account id that makes them admin, never by comparing emails. Each admin sign-in records (Plex account id, the email its bell is filed under); a new request notifies the emails recorded for the account that owns the admin token now.

**Files:**
- Modify: `app/models.py` (add `AdminContact` after `AccessRequest`)
- Create: `app/services/admin_contacts.py`
- Modify: `app/routers/auth.py` (record after the OIDC sign-in), `app/routers/plex_auth.py` (record after the Plex sign-in)
- Modify: `app/services/access_requests.py` (add `notify_admins`)
- Modify: `app/routers/notifications.py` (`NOTIFICATION_CATEGORIES`, `PreferencesUpdate.access`)
- Modify: `app/static/js/notifications.js` (icon, link, label; the toggle for admins only)
- Modify: `app/static/fonts/material-symbols-outlined.icons.txt` and the rebuilt font files (`person_add`)
- Modify: `app/static/css/app.css` (rebuilt: a JS file changed)
- Test: `app/tests/test_access_notify.py`

**Interfaces:**
- Consumes: `AccessRequest` (Task 4); `auth._fetch_owner_account(db)`; `notification_poller._create_notification_once(r, db, email, category, title, body, reference_id)`; `push.dispatch_push(emails, title, body, category, url)`.
- Produces:
  - `AdminContact` model, table `admin_contacts` (`plex_account_id` String(32) and `notify_email` String(200), together the primary key; `seen_at` DateTime not null).
  - `admin_contacts.remember(db, session_data: dict) -> bool`
  - `admin_contacts.emails_for(db, owner_account_id: str) -> list[str]`
  - `async svc.notify_admins(r, db, row: AccessRequest) -> int` (never raises; used by Task 7's submit)
  - Notification category `access`: title "Access request", body "<username> asked for access", reference `access:<id>`, push URL `/settings#access-requests`.

- [ ] **Step 1: Write the failing tests**

Create `app/tests/test_access_notify.py`:

```python
"""
Where the admin's request notices go (spec section 8, amended 2026-10-10): never by comparing
emails. Each admin sign-in records the Plex account id that made it admin and the email its bell is
filed under; a new request notifies the emails recorded for the account that owns the admin token.
So an admin whose Authentik email differs from the plex.tv email is still reached, and someone who
is admin only through the email allowlist is not.
"""
import asyncio
import re
import unittest
from pathlib import Path
from unittest import mock

try:
    import httpx  # noqa: F401
    from fastapi import FastAPI  # noqa: F401
    HAVE_APP = True
except ImportError:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

if HAVE_APP:
    from app.auth import session_manager
    from app.models import AccessRequest, AdminContact, Notification
    from app.routers import auth as oidc_auth
    from app.routers import plex_auth
    from app.routers.notifications import NOTIFICATION_CATEGORIES, PreferencesUpdate, _email_hash
    from app.services import access_requests as svc
    from app.services import admin_contacts
    from app.tests import helpers
    from app.tests.test_plex_pin_claim import NONCE, PIN
    from app.tests.test_ticket_claim_signin import FakeRedis, _SignInHarness

STATIC = Path(__file__).resolve().parents[1] / "static"
OWNER = {"is_admin": "true", "plex_account_id": "7"}


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class Remember(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.addCleanup(self.db.close)

    def rows(self):
        self.db.expire_all()
        return sorted((c.plex_account_id, c.notify_email) for c in self.db.query(AdminContact).all())

    def test_an_admin_session_is_recorded_once_per_email(self):
        self.assertTrue(admin_contacts.remember(self.db, {**OWNER, "email": " Jordan@Authentik.Example "}))
        first = self.db.query(AdminContact).one().seen_at
        self.assertTrue(admin_contacts.remember(self.db, {**OWNER, "email": "jordan@authentik.example"}))
        self.assertTrue(admin_contacts.remember(self.db, {**OWNER, "email": "owner@plex.example"}))
        self.assertEqual(self.rows(), [("7", "jordan@authentik.example"), ("7", "owner@plex.example")])
        again = self.db.query(AdminContact).filter_by(notify_email="jordan@authentik.example").one().seen_at
        self.assertGreaterEqual(again, first)

    def test_nothing_is_recorded_without_admin_an_email_or_a_plex_id(self):
        for session in ({"is_admin": "false", "plex_account_id": "7", "email": "a@example.com"},
                        {**OWNER, "email": ""}, {**OWNER, "email": "None"},
                        {"is_admin": "true", "plex_account_id": "", "email": "a@example.com"},
                        {"is_admin": "true", "email": "a@example.com"}):
            with self.subTest(session=session):
                self.assertFalse(admin_contacts.remember(self.db, session))
        self.assertEqual(self.rows(), [])

    def test_emails_for_the_owner_only(self):
        admin_contacts.remember(self.db, {**OWNER, "email": "b@example.com"})
        admin_contacts.remember(self.db, {**OWNER, "email": "a@example.com"})
        admin_contacts.remember(self.db, {"is_admin": "true", "plex_account_id": "99", "email": "c@example.com"})
        self.assertEqual(admin_contacts.emails_for(self.db, "7"), ["a@example.com", "b@example.com"])
        self.assertEqual(admin_contacts.emails_for(self.db, 7), ["a@example.com", "b@example.com"])
        self.assertEqual(admin_contacts.emails_for(self.db, ""), [])
        self.assertEqual(admin_contacts.emails_for(self.db, "8"), [])


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class SignInRecordsTheAdmin(_SignInHarness):
    """Both real sign-in callbacks record the admin's contact."""

    def owner_is(self, value):
        for p in (mock.patch.object(oidc_auth, "_is_plex_server_owner", mock.AsyncMock(return_value=value)),
                  mock.patch.object(plex_auth, "_is_plex_server_owner", mock.AsyncMock(return_value=value))):
            p.start()
            self.addCleanup(p.stop)

    def contacts(self):
        db = self.Session()
        try:
            return sorted((c.plex_account_id, c.notify_email) for c in db.query(AdminContact).all())
        finally:
            db.close()

    def plex_direct(self):
        self.redis.data[f"plex_pin:{PIN}"] = plex_auth._hash_pin_nonce(NONCE).encode()
        self.plex_tv({"id": 7, "username": "owner", "title": "Owner", "email": "Owner@Plex.example", "thumb": ""})

        async def flow(client):
            r = await client.post("/auth/plex-callback", json={"pin_id": PIN},
                                  cookies={plex_auth.PLEX_PIN_COOKIE: NONCE})
            self.assertEqual(r.status_code, 200, r.text)
        self.drive(flow)

    def authentik(self):
        userinfo = {"sub": "oidc-sub-1", "preferred_username": "jordan", "name": "Jordan",
                    "email": "Jordan@Authentik.Example", "plex_token": "plex-token"}

        class OIDC:
            redirect_uri = ""

            async def exchange_code_for_token(self, code, code_verifier=""):
                return {"access_token": "at", "id_token": ""}

            async def get_userinfo(self, access_token):
                return dict(userinfo)

        for p in (mock.patch.object(oidc_auth, "get_oidc_client", return_value=OIDC()),
                  mock.patch.object(session_manager, "consume_oidc_flow",
                                    mock.AsyncMock(return_value={"state": "st", "code_verifier": "", "nonce": ""})),
                  mock.patch.object(oidc_auth.seerr, "authenticate_with_plex_token", mock.AsyncMock(return_value=None))):
            p.start()
            self.addCleanup(p.stop)
        self.plex_tv({"id": 7, "username": "owner", "email": "owner@plex.example", "thumb": "", "confirmed": True})

        async def flow(client):
            r = await client.get("/auth/callback", params={"code": "c", "state": "st"},
                                 cookies={oidc_auth.OIDC_FLOW_COOKIE: "flow"})
            self.assertEqual(r.status_code, 302, r.text)
        self.drive(flow)

    def test_plex_direct_records_the_plex_email(self):
        self.owner_is(True)
        self.plex_direct()
        self.assertEqual(self.contacts(), [("7", "owner@plex.example")])

    def test_authentik_records_the_authentik_email_under_the_plex_id(self):
        self.owner_is(True)
        self.authentik()
        self.assertEqual(self.contacts(), [("7", "jordan@authentik.example")])

    def test_a_member_records_nothing(self):
        self.owner_is(False)
        self.plex_direct()
        self.assertEqual(self.contacts(), [])

    def test_a_failing_record_never_refuses_the_sign_in(self):
        self.owner_is(True)
        with mock.patch.object(admin_contacts, "remember", side_effect=RuntimeError("db gone")):
            self.plex_direct()      # asserts the 200 itself
            self.authentik()        # asserts the 302 itself


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class Notify(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.addCleanup(self.db.close)
        self.redis = FakeRedis()
        self.push = mock.AsyncMock(return_value={"attempted": 1, "succeeded": 1})
        self.owner = mock.AsyncMock(return_value={"id": 7, "email": "owner@plex.example"})
        for p in (mock.patch("app.services.push.dispatch_push", self.push),
                  mock.patch("app.routers.auth._fetch_owner_account", self.owner)):
            p.start()
            self.addCleanup(p.stop)
        self.row = AccessRequest(plex_account_id="5551", plex_username="newperson", name="New",
                                 note="SECRET-NOTE text", status="pending", created_at=svc.now_utc())
        self.db.add(self.row)
        self.db.commit()
        admin_contacts.remember(self.db, {**OWNER, "email": "jordan@authentik.example"})
        admin_contacts.remember(self.db, {**OWNER, "email": "owner@plex.example"})
        admin_contacts.remember(self.db, {"is_admin": "true", "plex_account_id": "99", "email": "allowlisted@example.com"})
        helpers.put(self.db, "system.admin_email", "allowlisted@example.com")

    def notify(self):
        return asyncio.run(svc.notify_admins(self.redis, self.db, self.row))

    def bells(self):
        self.db.expire_all()
        return sorted((n.user_email, n.category, n.title, n.body, n.reference_id)
                      for n in self.db.query(Notification).all())

    def test_the_owners_contacts_get_a_bell_and_one_push(self):
        self.assertEqual(self.notify(), 2)
        ref = f"access:{self.row.id}"
        self.assertEqual(self.bells(), [
            ("jordan@authentik.example", "access", "Access request", "newperson asked for access", ref),
            ("owner@plex.example", "access", "Access request", "newperson asked for access", ref)])
        self.push.assert_awaited_once()
        emails, title, body, category, url = self.push.await_args.args
        self.assertEqual((sorted(emails), title, body, category, url),
                         (["jordan@authentik.example", "owner@plex.example"], "Access request",
                          "newperson asked for access", "access", "/settings#access-requests"))

    def test_the_note_never_reaches_a_bell_or_a_push(self):
        self.notify()
        self.assertNotIn("SECRET-NOTE", repr(self.bells()))
        self.assertNotIn("SECRET-NOTE", repr(self.push.await_args))

    def test_an_allowlist_only_admin_gets_nothing(self):
        self.notify()
        self.assertNotIn("allowlisted@example.com", [b[0] for b in self.bells()])
        self.assertNotIn("allowlisted@example.com", self.push.await_args.args[0])

    def test_once_per_request(self):
        self.notify()
        self.assertEqual(self.notify(), 0)
        self.assertEqual(len(self.bells()), 2)
        self.push.assert_awaited_once()

    def test_a_preference_turned_off_is_kept(self):
        helpers.put(self.db, f"notify.{_email_hash('jordan@authentik.example')}.access", "false")
        self.assertEqual(self.notify(), 1)
        self.assertEqual(self.push.await_args.args[0], ["owner@plex.example"])

    def test_no_owner_means_no_notice_and_no_error(self):
        self.owner.return_value = None
        with self.assertLogs("app.services.access_requests", level="WARNING") as logs:
            self.assertEqual(self.notify(), 0)
        self.assertIn(f"Access request {self.row.id}", "\n".join(logs.output))
        self.assertEqual(self.bells(), [])
        self.push.assert_not_awaited()

    def test_a_push_failure_keeps_the_bells(self):
        self.push.side_effect = RuntimeError("push service down")
        self.assertEqual(self.notify(), 2)
        self.assertEqual(len(self.bells()), 2)


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class Category(unittest.TestCase):
    def test_the_server_knows_the_access_category(self):
        self.assertEqual(NOTIFICATION_CATEGORIES[-1], "access")
        self.assertIn("access", PreferencesUpdate.model_fields)

    def test_the_bell_draws_links_and_names_it_and_only_admins_see_its_toggle(self):
        js = (STATIC / "js" / "notifications.js").read_text(encoding="utf-8")
        self.assertRegex(js, r"access: 'person_add'")
        self.assertRegex(js, r"access: '/settings#access-requests'")
        self.assertRegex(js, r"access: 'Access requests'")
        self.assertIn("if (cat === 'access' && !isAdmin) return;", js)
        icons = (STATIC / "fonts" / "material-symbols-outlined.icons.txt").read_text(encoding="utf-8").split()
        self.assertIn("person_add", icons)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run them and see them fail**

Run: `ssh webserver "docker exec -i webservarr-dev python - -v" < app/tests/test_access_notify.py`
Expected: `ImportError` for `AdminContact` (or `app.services.admin_contacts`).

- [ ] **Step 3: Add the model**

In `app/models.py`, after `AccessRequest`:

```python
class AdminContact(Base):
    """Where an admin's notices go (spec 2026-10-10-request-access-design.md,
    section 8): the Plex account id that made a session admin, and the email
    its bell and push are filed under (utils.identity_email of the session's
    email). The admin is found by this account id, never by comparing
    emails. app/services/admin_contacts.py owns it."""

    __tablename__ = "admin_contacts"

    plex_account_id = Column(String(32), primary_key=True)
    notify_email = Column(String(200), primary_key=True)
    seen_at = Column(DateTime, nullable=False)
```

- [ ] **Step 4: Write the contacts module**

Create `app/services/admin_contacts.py`:

```python
"""
Where the admin's notices go (docs/superpowers/specs/2026-10-10-request-access-design.md,
section 8).

The bell and push are keyed by the email of the signed-in session
(utils.identity_email), and an admin who signs in through Authentik carries
Authentik's email claim, which need not be the plex.tv owner's. So the admin
is never found by comparing emails. Each admin sign-in records the pair it
knows for certain: the session's immutable Plex account id and the email its
bell is filed under. A notice for the admin goes to the emails recorded for
the account id that owns the admin token now: the id rule sign-in uses to
make someone admin (auth._is_plex_server_owner).
"""
from datetime import datetime, timezone
from typing import List

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import AdminContact
from app.utils import identity_email


def remember(db: Session, session_data: dict) -> bool:
    """Record an admin session's (Plex account id, notice email), or refresh
    its seen_at. False, and nothing written, for a member or a session with
    no Plex account id or no email."""
    if session_data.get("is_admin") != "true":
        return False
    account_id = str(session_data.get("plex_account_id") or "")
    email = identity_email(session_data.get("email"))
    if not account_id or not email:
        return False
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    row = db.get(AdminContact, (account_id, email))
    if row is None:
        db.add(AdminContact(plex_account_id=account_id, notify_email=email, seen_at=now))
    else:
        row.seen_at = now
    try:
        db.commit()
    except IntegrityError:
        db.rollback()   # the other worker recorded the same pair a moment ago
    return True


def emails_for(db: Session, owner_account_id) -> List[str]:
    """The notice emails recorded for the account that owns the admin token."""
    owner = str(owner_account_id or "")
    if not owner:
        return []
    rows = db.query(AdminContact.notify_email).filter(AdminContact.plex_account_id == owner).all()
    return sorted({email for (email,) in rows if email})
```

- [ ] **Step 5: Record at both sign-ins**

In `app/routers/auth.py`, add `from app.services import admin_contacts` to the imports. In `oidc_callback`, right after the `claim_legacy_tickets` try/except:

```python
        # Where this admin's notices go: the Plex account id that made them
        # admin and the email their bell is filed under (request access spec,
        # section 8). Never a reason to refuse the sign-in.
        try:
            admin_contacts.remember(db, session_data)
        except Exception as e:
            logger.warning("Recording the admin's notice address failed (sign-in continues): %s", type(e).__name__)
```

In `app/routers/plex_auth.py`, add `from app.services import admin_contacts` to the imports and the same block right after its `claim_legacy_tickets` try/except.

- [ ] **Step 6: The notice**

Append to `app/services/access_requests.py` (and add `import logging` and `logger = logging.getLogger(__name__)` at its top):

```python
async def notify_admins(r, db: Session, row: AccessRequest) -> int:
    """File an "access" bell for every admin contact of the account that owns
    the admin token, and push it to their devices (spec section 8). The admin
    is found by Plex account id, never by comparing emails. Returns how many
    bells were filed. Never raises: a notice that can't go out must not fail
    the request, and the Settings badge still counts it. The note is never
    in a bell or a push."""
    # At call time: the poller imports this module, and the auth router the app.
    from app.routers.auth import _fetch_owner_account
    from app.services import admin_contacts
    from app.services.notification_poller import _create_notification_once
    from app.services.push import dispatch_push

    title, body = "Access request", f"{row.plex_username} asked for access"
    try:
        owner = await _fetch_owner_account(db) or {}
        # The id _is_plex_server_owner compares a signing-in account with.
        owner_id = str(owner.get("id") or owner.get("uuid") or "")
        if not owner_id:
            logger.warning("Access request %s: the server owner couldn't be read; no notice sent", row.id)
            return 0
        told = []
        for email in admin_contacts.emails_for(db, owner_id):
            if await _create_notification_once(r, db, email, "access", title, body, f"access:{row.id}"):
                told.append(email)
    except Exception as exc:
        logger.warning("Access request %s: the admin notice failed: %s", row.id, type(exc).__name__)
        return 0
    if told:
        try:
            await dispatch_push(told, title, body, "access", "/settings#access-requests")
        except Exception as exc:
            logger.warning("Access request %s: the push failed: %s", row.id, type(exc).__name__)
    return len(told)
```

- [ ] **Step 7: The category on the server and in the bell**

In `app/routers/notifications.py`:

```python
    # A new request for access (Settings > Access requests). Only admins
    # are ever sent it; notifications.js shows its toggle to admins only.
    access: Optional[bool] = None
```
added as the last field of `PreferencesUpdate`, and

```python
NOTIFICATION_CATEGORIES = ("request", "issue", "status", "news", "ticket", "books", "access")
```

In `app/static/js/notifications.js`, add `access: 'person_add'` to `CATEGORY_ICONS`, `access: '/settings#access-requests'` to `CATEGORY_URLS`, `access: 'Access requests'` to `CATEGORY_LABELS` (each as the last entry, with a comma after the previous one). In the preferences modal:

```js
    // Category toggles: every category the server sends (NOTIFICATION_CATEGORIES)
    var categories = ['request', 'issue', 'status', 'news', 'ticket', 'books', 'access'];
    // Books only on a site that has books (features.books_configured).
    var features = (((window.WS_DATA || {}).branding || {}).features) || {};
    // Access requests only go to admins, so only an admin gets the toggle.
    var isAdmin = !!(((window.WS_DATA || {}).user || {}).is_admin);
    categories.forEach(function(cat) {
      if (cat === 'books' && features.books_configured === false) return;
      if (cat === 'access' && !isAdmin) return;
```

- [ ] **Step 8: Put the icon in the trimmed font**

Add `person_add` on its own line after `person` in the first block of `app/static/fonts/material-symbols-outlined.icons.txt`. Rebuild the font (the script downloads Google's pinned source font and checks its SHA-256):

Run: `python3 -m venv /tmp/iconfont`
Run: `/tmp/iconfont/bin/pip install fonttools brotli`
Run: `/tmp/iconfont/bin/python scripts/build_icon_font.py`
Expected: it writes `app/static/fonts/material-symbols-outlined.woff2`, `app/static/fonts/material-symbols-outlined.json` and `app/tests/material_symbols_names.txt`.

- [ ] **Step 9: Rebuild the CSS stamp**

Run: `npm ci --no-audit --no-fund` (first time in this worktree), then `npm run build:css`.
Expected: `app/static/css/app.css` changes (its stamp hashes notifications.js).

- [ ] **Step 10: Commit**

```bash
git add app/models.py app/services/admin_contacts.py app/routers/auth.py app/routers/plex_auth.py app/services/access_requests.py app/routers/notifications.py app/static/js/notifications.js app/static/fonts/material-symbols-outlined.icons.txt app/static/fonts/material-symbols-outlined.woff2 app/static/fonts/material-symbols-outlined.json app/tests/material_symbols_names.txt app/static/css/app.css app/tests/test_access_notify.py
git commit -m "feat(access): admin notices go by the owner's Plex account id, never by email"
```

- [ ] **Step 11: Deploy to dev and run the tests**

Deploy sequence with restart. Run: `ssh webserver "docker exec webservarr-dev python -m unittest app.tests.test_access_notify -v"`; then `app.tests.test_icon_font`, `app.tests.test_shell_contract`, `app.tests.test_ticket_claim_signin`, `app.tests.test_plex_pin_claim` the same way; then the full suite; then `npm run test:js` locally. Expected: all green. CI green.

### Task 7: Public routes and the callback page's access branch

**Files:**
- Modify: `app/routers/auth.py` (`_server_membership`; `_user_has_server_access` uses it)
- Create: `app/routers/access_requests.py` (public router; Task 8 adds the admin router)
- Modify: `app/main.py` (import and register the router)
- Modify: `app/static/js/plex-callback.js` (`for=access`)
- Modify: `app/static/css/app.css` (rebuilt), `package.json`, `.github/workflows/docker-publish.yml`
- Test: `app/tests/test_access_public.py`, `app/tests/js/plex_callback.mjs`

**Interfaces:**
- Consumes: `svc.is_open`, `svc.clean_form`, `svc.FormProblem`, `svc.state_for`, `svc.place`, `svc.CapReached`, `svc.safe_avatar_url`, `svc.now_utc`, `svc.notify_admins` (Tasks 4, 6); `plex_share.find_share`, `plex_share.PlexShareUnavailable` (Task 5); `auth._fetch_plex_account`; `plex_auth._get_plex_client_id`, `plex_auth._plex_headers`, `plex_auth._hash_pin_nonce`.
- Produces:
  - `auth._server_membership(plex_token, db) -> "member" | "not_member" | "unknown"`
  - `POST /api/access-requests/pin` returns `{pin_id: int, auth_url: str}`; sets `webservarr_access_pin` (HttpOnly, SameSite=Lax, Path `/api/access-requests`, 300 s).
  - `POST /api/access-requests/identify` `{pin_id}` returns `{state, username, avatar_url, submitted_at?, can_ask_after?}` with `state` in `member|invited|pending|approved|denied|blocked|new`; for `new` sets `webservarr_access_ticket` (HttpOnly, SameSite=Strict, Path `/api/access-requests`, 900 s).
  - `POST /api/access-requests` `{name, note}` returns `{state: "pending", sent: true}` for a new request, or `{state, sent: false, submitted_at?, can_ask_after?}` when the account already has one.
  - Error details the card shows as given (the card matches only `NOT_YET` exactly): `CLOSED` 403, `EXPIRED` 400, `NOT_YET` 400, `BUSY` 409, `PLEX_DOWN` 503, `TIMED_OUT` 400, `FULL` 503, `SUBMIT_BUSY` 503, form problems 422.
  - Module constants `PIN_COOKIE`, `TICKET_COOKIE`, `COOKIE_PATH`, `SUBMIT_LOCK`, `SUBMIT_LOCK_TRIES`, `SUBMIT_LOCK_WAIT` (tests patch the last two).
  - `plex-callback.js`: in a popup, posts `{type: 'plex-access-complete'}` when its own URL has `for=access` exactly; as a redirect, goes to `/login?access_request=complete`.

- [ ] **Step 1: Write the failing Python tests**

Create `app/tests/test_access_public.py`:

```python
"""
The public request routes (spec section 6): the gate, the PIN and its browser binding in a namespace
of its own, identify's states, the one-use ticket, submit's rules under the submit lock, the token
that must never be kept, rate limits, input limits and same-origin. Plex is faked at the router's
own helpers, so nothing here reaches plex.tv.
"""
import asyncio
import json
import unittest
from pathlib import Path
from unittest import mock

try:
    import httpx  # noqa: F401
    from fastapi import FastAPI  # noqa: F401
    HAVE_APP = True
except ImportError:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

if HAVE_APP:
    import httpx
    from fastapi import FastAPI
    from fastapi.testclient import TestClient  # noqa: F401
    from app.auth import session_manager
    from app.config import settings
    from app.database import Base, get_db
    from app.integrations import plex_share
    from app.limiter import limiter
    from app.models import AccessRequest
    from app.routers import access_requests as access
    from app.routers import auth, plex_auth
    from app.services import access_requests as svc
    from app.tests import helpers
    from app.tests.test_integration_health import _private_limiter
    from app.tests.test_settings_gate import SettingsGateBase
    RealAsyncClient = httpx.AsyncClient

BASE = "/api/access-requests"
PIN = 424242
TOKEN = "PLEXTOKEN-SENTINEL-1f2e3d"
ADMIN_TOKEN = "ADMIN-TOKEN-NEVER-SHOWN"
ACCOUNT = {"id": 5551, "username": "newperson", "email": "new@example.com",
           "thumb": "https://plex.tv/users/abc/avatar?c=1"}


class FakeRedis:
    """The calls the routes make, with Redis's semantics, on one event loop."""

    def __init__(self):
        self.data = {}

    async def get(self, key):
        return self.data.get(key)

    async def set(self, key, value, nx=False, ex=None):
        if nx and key in self.data:
            return None
        self.data[key] = value.encode() if isinstance(value, str) else value
        return True

    async def setex(self, key, ttl, value):
        return await self.set(key, value)

    async def getdel(self, key):
        return self.data.pop(key, None)

    async def delete(self, *keys):
        return sum(self.data.pop(k, None) is not None for k in keys)


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class Membership(unittest.TestCase):
    def answer(self, configured, user):
        with mock.patch.object(auth, "_fetch_configured_server_identifiers", mock.AsyncMock(return_value=configured)), \
             mock.patch.object(auth, "_fetch_server_identifiers_for_token", user), \
             mock.patch.object(auth, "_plex_client_headers", return_value={}):
            return (asyncio.run(auth._server_membership("tok", None)),
                    asyncio.run(auth._user_has_server_access("tok", None)))

    def test_three_ways_and_the_old_gate_still_fails_closed(self):
        self.assertEqual(self.answer({"m"}, mock.AsyncMock(return_value={"m", "x"})), ("member", True))
        self.assertEqual(self.answer({"m"}, mock.AsyncMock(return_value={"x"})), ("not_member", False))
        self.assertEqual(self.answer(set(), mock.AsyncMock(return_value={"m"})), ("unknown", False))
        self.assertEqual(self.answer({"m"}, mock.AsyncMock(side_effect=RuntimeError("HTTP 500"))), ("unknown", False))
        self.assertEqual(asyncio.run(auth._server_membership("", None)), "not_member")


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class Harness(unittest.TestCase):
    """The access router and the Plex sign-in router alone, an in-memory
    database with the feature on, a fake Redis, and Plex faked at the
    router's helpers."""

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        db = self.Session()
        for key, value in (("access_requests.enabled", "true"), ("integration.plex.url", "http://192.168.1.2:32400"),
                           ("integration.plex.token", ADMIN_TOKEN)):
            helpers.put(db, key, value)
        db.close()
        self.redis = FakeRedis()
        self.token = TOKEN
        self.accounts = [dict(ACCOUNT)]
        self.membership = "not_member"
        self.share = None
        self.create_session = mock.AsyncMock()
        self.notify = mock.AsyncMock(return_value=0)

        self.app = FastAPI()
        self.app.state.limiter = limiter
        self.app.include_router(access.router, prefix=BASE)
        self.app.include_router(plex_auth.router, prefix="/auth")

        def _db():
            d = self.Session()
            try:
                yield d
            finally:
                d.close()
        self.app.dependency_overrides[get_db] = _db
        was = limiter.enabled
        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", was)

        async def pin_token(pin_id, client_id):
            await asyncio.sleep(0.02)
            return self.token

        async def plex_account(token, headers=None):
            self.assertEqual(token, TOKEN)
            return self.accounts.pop(0) if len(self.accounts) > 1 else dict(self.accounts[0])

        async def membership(token, db):
            return self.membership

        async def find_share(account_id):
            if isinstance(self.share, Exception):
                raise self.share
            return self.share

        for p in (mock.patch.object(session_manager, "get_redis", mock.AsyncMock(return_value=self.redis)),
                  mock.patch.object(session_manager, "create_session", self.create_session),
                  mock.patch.object(access, "_create_pin", mock.AsyncMock(return_value=(PIN, "CODE"))),
                  mock.patch.object(access, "_pin_token", side_effect=pin_token),
                  mock.patch.object(auth, "_fetch_plex_account", side_effect=plex_account),
                  mock.patch.object(auth, "_server_membership", side_effect=membership),
                  mock.patch.object(plex_share, "find_share", side_effect=find_share),
                  mock.patch.object(plex_auth, "_get_plex_client_id", return_value="client-id"),
                  mock.patch.object(svc, "notify_admins", self.notify)):
            p.start()
            self.addCleanup(p.stop)

    def drive(self, flow, origin=True):
        async def go():
            async with RealAsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="https://testserver",
                                       headers=helpers.SAME_ORIGIN if origin else None) as c:
                return await flow(c)
        return asyncio.run(go())

    async def pin(self, c):
        c.cookies.clear()
        r = await c.post(BASE + "/pin")
        self.assertEqual(r.status_code, 200, r.text)
        return r.cookies.get(access.PIN_COOKIE)

    async def identify(self, c, nonce, pin_id=PIN, cookie=None):
        c.cookies.clear()
        cookies = {cookie or access.PIN_COOKIE: nonce} if nonce else None
        return await c.post(BASE + "/identify", json={"pin_id": pin_id}, cookies=cookies)

    async def ticket(self, c):
        r = await self.identify(c, await self.pin(c))
        self.assertEqual(r.json()["state"], "new", r.text)
        return r.cookies.get(access.TICKET_COOKIE)

    async def submit(self, c, ticket, name="New Person", note="A friend of Sam."):
        c.cookies.clear()
        return await c.post(BASE, json={"name": name, "note": note},
                            cookies={access.TICKET_COOKIE: ticket} if ticket else None)

    def rows(self):
        db = self.Session()
        try:
            return db.query(AccessRequest).all()
        finally:
            db.close()

    def add_row(self, account_id, status, **kw):
        db = self.Session()
        try:
            db.add(AccessRequest(plex_account_id=account_id, plex_username="u", name="N", note="n", status=status,
                                 created_at=svc.now_utc(), **kw))
            db.commit()
        finally:
            db.close()

    def set_open(self, value):
        db = self.Session()
        try:
            helpers.put(db, "access_requests.enabled", value)
        finally:
            db.close()


class Gate(Harness):
    def test_closed_refuses_every_route_before_anything_else(self):
        self.set_open("false")

        async def flow(c):
            return [await c.post(BASE + "/pin"), await self.identify(c, "x"), await self.submit(c, "t")]
        for r in self.drive(flow):
            self.assertEqual((r.status_code, r.json()["detail"]), (403, access.CLOSED))
        access._create_pin.assert_not_awaited()

    def test_plex_not_set_up_is_closed_too(self):
        db = self.Session()
        helpers.put(db, "integration.plex.token", "")
        db.close()
        r = self.drive(lambda c: c.post(BASE + "/pin"))
        self.assertEqual(r.status_code, 403)


class Pin(Harness):
    def test_a_pin_bound_to_this_browser_in_its_own_namespace(self):
        r = self.drive(lambda c: c.post(BASE + "/pin"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["pin_id"], PIN)
        self.assertIn("forwardUrl=https%3A%2F%2Ftestserver%2Fauth%2Fplex-callback-page%3Ffor%3Daccess", r.json()["auth_url"])
        cookie = [h for h in r.headers.get_list("set-cookie") if h.startswith(access.PIN_COOKIE + "=")][0].lower()
        for part in ("httponly", "samesite=lax", "path=/api/access-requests", "max-age=300"):
            self.assertIn(part, cookie)
        nonce = r.cookies.get(access.PIN_COOKIE)
        self.assertEqual(self.redis.data[f"access_pin:{PIN}"].decode(), plex_auth._hash_pin_nonce(nonce))
        self.assertNotIn(nonce.encode(), b"".join(self.redis.data.values()))
        self.assertNotIn(f"plex_pin:{PIN}", self.redis.data)


class Identify(Harness):
    def test_the_binding_gives_one_error_and_takes_no_claim(self):
        async def flow(c):
            await self.pin(c)
            return [await self.identify(c, None), await self.identify(c, "someone-else"),
                    await self.identify(c, "x", pin_id=999)]
        answers = {(r.status_code, r.json()["detail"]) for r in self.drive(flow)}
        self.assertEqual(answers, {(400, access.EXPIRED)})
        self.assertNotIn(f"access_pin_claim:{PIN}", self.redis.data)

    def test_two_at_once_one_wins(self):
        async def flow(c):
            nonce = await self.pin(c)
            c.cookies.clear()
            rs = await asyncio.gather(*[c.post(BASE + "/identify", json={"pin_id": PIN},
                                               cookies={access.PIN_COOKIE: nonce}) for _ in range(2)])
            return sorted(r.status_code for r in rs)
        self.assertEqual(self.drive(flow), [200, 409])

    def test_not_yet_authorized_releases_the_claim_and_keeps_the_pin(self):
        self.token = ""

        async def flow(c):
            return await self.identify(c, await self.pin(c))
        r = self.drive(flow)
        self.assertEqual((r.status_code, r.json()["detail"]), (400, access.NOT_YET))
        self.assertNotIn(f"access_pin_claim:{PIN}", self.redis.data)
        self.assertIn(f"access_pin:{PIN}", self.redis.data)

    def test_plex_down_or_unsure_is_503_never_not_a_member(self):
        for case in ("no account", "unknown"):
            with self.subTest(case):
                self.accounts = [{}] if case == "no account" else [dict(ACCOUNT)]
                self.membership = "unknown"

                async def flow(c):
                    return await self.identify(c, await self.pin(c))
                r = self.drive(flow)
                self.assertEqual((r.status_code, r.json()["detail"]), (503, access.PLEX_DOWN))
                self.assertNotIn(access.TICKET_COOKIE, r.headers.get("set-cookie", ""))

    def state(self):
        async def flow(c):
            return await self.identify(c, await self.pin(c))
        r = self.drive(flow)
        self.assertEqual(r.status_code, 200, r.text)
        return r

    def test_each_state(self):
        self.membership = "member"
        self.assertEqual(self.state().json(), {"state": "member", "username": "newperson",
                                               "avatar_url": "https://plex.tv/users/abc/avatar?c=1"})
        self.membership = "not_member"
        self.share = "pending"
        self.assertEqual(self.state().json()["state"], "invited")
        self.share = plex_share.PlexShareUnavailable("down")
        self.assertEqual(self.state().json()["state"], "new")
        self.share = None
        for status, extra in (("pending", {}), ("approved", {"decided_at": svc.now_utc()}),
                              ("blocked", {"decided_at": svc.now_utc()}),
                              ("denied", {"decided_at": svc.now_utc(), "cooldown_until": svc.now_utc() + svc.COOLDOWN})):
            with self.subTest(status):
                db = self.Session()
                db.query(AccessRequest).delete()
                db.commit()
                db.close()
                self.add_row("5551", status, **extra)
                body = self.state().json()
                self.assertEqual(body["state"], status)
                if status == "denied":
                    self.assertTrue(body["can_ask_after"].endswith("Z"))
                self.assertNotIn("new@example.com", json.dumps(body))

    def test_new_gets_a_one_use_ticket_and_never_an_email(self):
        r = self.state()
        body = r.json()
        self.assertEqual(body["state"], "new")
        self.assertNotIn("email", body)
        cookie = [h for h in r.headers.get_list("set-cookie") if h.startswith(access.TICKET_COOKIE + "=")][0].lower()
        for part in ("httponly", "samesite=strict", "path=/api/access-requests", "max-age=900"):
            self.assertIn(part, cookie)
        ticket = r.cookies.get(access.TICKET_COOKIE)
        stored = json.loads(self.redis.data[f"access_ticket:{plex_auth._hash_pin_nonce(ticket)}"])
        self.assertEqual(stored, {"plex_account_id": "5551", "plex_username": "newperson",
                                  "plex_email": "new@example.com",
                                  "plex_avatar_url": "https://plex.tv/users/abc/avatar?c=1"})
        self.assertNotIn(f"access_pin:{PIN}", self.redis.data)   # the PIN is used up

    def test_the_two_pin_namespaces_never_cross(self):
        self.redis.data[f"plex_pin:{PIN}"] = plex_auth._hash_pin_nonce("signin-nonce").encode()

        async def sign_in_pin_cannot_identify(c):
            return [await self.identify(c, "signin-nonce"),
                    await self.identify(c, "signin-nonce", cookie=plex_auth.PLEX_PIN_COOKIE)]
        for r in self.drive(sign_in_pin_cannot_identify):
            self.assertEqual(r.status_code, 400)
        del self.redis.data[f"plex_pin:{PIN}"]

        async def access_pin_cannot_sign_in(c):
            nonce = await self.pin(c)
            c.cookies.clear()
            return await c.post("/auth/plex-callback", json={"pin_id": PIN},
                                cookies={plex_auth.PLEX_PIN_COOKIE: nonce, access.PIN_COOKIE: nonce})
        with mock.patch.object(plex_auth, "_plex_auth_enabled", return_value=True):
            r = self.drive(access_pin_cannot_sign_in)
        self.assertEqual(r.status_code, 400)
        self.create_session.assert_not_awaited()


class Submit(Harness):
    def test_a_request_is_made_once_with_its_ticket(self):
        async def flow(c):
            t = await self.ticket(c)
            return t, await self.submit(c, t), await self.submit(c, t)
        ticket, first, again = self.drive(flow)
        self.assertEqual((first.status_code, first.json()), (200, {"state": "pending", "sent": True}))
        self.assertIn(f"{access.TICKET_COOKIE}=", first.headers.get("set-cookie", ""))   # cleared
        self.assertEqual((again.status_code, again.json()["detail"]), (400, access.TIMED_OUT))
        self.assertEqual([(r.plex_account_id, r.status, r.name) for r in self.rows()], [("5551", "pending", "New Person")])
        self.notify.assert_awaited_once()

    def test_no_or_forged_or_expired_ticket(self):
        async def flow(c):
            t = await self.ticket(c)
            self.redis.data.clear()
            return [await self.submit(c, None), await self.submit(c, "forged-ticket"), await self.submit(c, t)]
        for r in self.drive(flow):
            self.assertEqual((r.status_code, r.json()["detail"]), (400, access.TIMED_OUT))
        self.assertEqual(self.rows(), [])

    def test_a_form_problem_keeps_the_ticket(self):
        async def flow(c):
            t = await self.ticket(c)
            return t, await self.submit(c, t, name="n" * 81), await self.submit(c, t, note=""), await self.submit(c, t)
        _, bad_name, bad_note, good = self.drive(flow)
        self.assertEqual((bad_name.status_code, bad_name.json()["detail"]), (422, svc.NAME_PROBLEM))
        self.assertEqual((bad_note.status_code, bad_note.json()["detail"]), (422, svc.NOTE_PROBLEM))
        self.assertEqual(good.json(), {"state": "pending", "sent": True})

    def test_an_open_request_made_meanwhile_answers_with_its_state(self):
        async def flow(c):
            t = await self.ticket(c)
            self.add_row("5551", "pending")      # another tab sent one after this identify
            return await self.submit(c, t)
        r = self.drive(flow)
        self.assertEqual((r.status_code, r.json()["state"], r.json()["sent"]), (200, "pending", False))
        self.assertEqual(len(self.rows()), 1)
        self.notify.assert_not_awaited()

    def test_switched_off_mid_flow(self):
        async def flow(c):
            t = await self.ticket(c)
            self.set_open("false")
            return t, await self.submit(c, t)
        ticket, r = self.drive(flow)
        self.assertEqual((r.status_code, r.json()["detail"]), (403, access.CLOSED))
        self.assertEqual(self.rows(), [])

    def test_place_runs_only_under_the_submit_lock(self):
        seen = []
        real = svc.place

        def place(*a, **kw):
            seen.append(access.SUBMIT_LOCK in self.redis.data)
            return real(*a, **kw)

        async def flow(c):
            return await self.submit(c, await self.ticket(c))
        with mock.patch.object(svc, "place", side_effect=place):
            self.assertEqual(self.drive(flow).status_code, 200)
        self.assertEqual(seen, [True])
        self.assertNotIn(access.SUBMIT_LOCK, self.redis.data)

    def test_a_held_lock_is_503_and_keeps_the_ticket(self):
        async def flow(c):
            t = await self.ticket(c)
            self.redis.data[access.SUBMIT_LOCK] = b"another-worker"
            return t, await self.submit(c, t)
        with mock.patch.object(access, "SUBMIT_LOCK_TRIES", 2), mock.patch.object(access, "SUBMIT_LOCK_WAIT", 0):
            ticket, r = self.drive(flow)
        self.assertEqual((r.status_code, r.json()["detail"]), (503, access.SUBMIT_BUSY))
        self.assertIn(f"access_ticket:{plex_auth._hash_pin_nonce(ticket)}", self.redis.data)
        self.assertEqual(self.redis.data[access.SUBMIT_LOCK], b"another-worker")

    def test_the_cap_holds_under_concurrent_submits(self):
        for i in range(svc.OPEN_CAP - 1):
            self.add_row(str(9000 + i), "pending")
        self.accounts = [{**ACCOUNT, "id": 7001}, {**ACCOUNT, "id": 7002}, {**ACCOUNT, "id": 7003}, {**ACCOUNT, "id": 7003}]

        async def flow(c):
            tickets = [await self.ticket(c) for _ in range(3)]
            c.cookies.clear()
            rs = await asyncio.gather(*[c.post(BASE, json={"name": "N", "note": "n"},
                                               cookies={access.TICKET_COOKIE: t}) for t in tickets])
            return sorted((r.status_code, r.json().get("detail")) for r in rs)
        codes = self.drive(flow)
        self.assertEqual(codes, [(200, None), (503, access.FULL), (503, access.FULL)])
        self.assertEqual(len([r for r in self.rows() if r.status == "pending"]), svc.OPEN_CAP)

    def test_one_open_request_per_account_under_concurrent_submits(self):
        async def flow(c):
            tickets = [await self.ticket(c) for _ in range(2)]
            c.cookies.clear()
            rs = await asyncio.gather(*[c.post(BASE, json={"name": "N", "note": "n"},
                                               cookies={access.TICKET_COOKIE: t}) for t in tickets])
            return sorted(r.json()["sent"] for r in rs)
        self.assertEqual(self.drive(flow), [False, True])
        self.assertEqual(len(self.rows()), 1)


class Limits(Harness):
    def test_input_limits(self):
        async def flow(c):
            t = await self.ticket(c)
            out = {
                "pin_id text": await c.post(BASE + "/identify", json={"pin_id": "abc"}),
                "pin_id zero": await c.post(BASE + "/identify", json={"pin_id": 0}),
                "pin_id huge": await c.post(BASE + "/identify", json={"pin_id": 2 ** 60}),
                "deep body": await c.post(BASE + "/identify", content="[" * 40 + "]" * 40,
                                          headers={"Content-Type": "application/json"}),
                "raw name too long": await self.submit(c, t, name="n" * 201),
                "raw note too long": await self.submit(c, t, note="n" * 4001),
                "lone surrogate": await c.post(BASE, content='{"name": "\\ud800", "note": "x"}',
                                               headers={"Content-Type": "application/json"},
                                               cookies={access.TICKET_COOKIE: t}),
                "control in name": await self.submit(c, t, name="Sam\x07"),
            }
            return t, out
        ticket, out = self.drive(flow)
        for what, r in out.items():
            with self.subTest(what):
                self.assertEqual(r.status_code, 422, r.text)
        self.assertIn(f"access_ticket:{plex_auth._hash_pin_nonce(ticket)}", self.redis.data)

    def test_same_origin_is_required(self):
        async def flow(c):
            return [await c.post(BASE + "/pin"), await c.post(BASE + "/identify", json={"pin_id": PIN}),
                    await c.post(BASE, json={"name": "N", "note": "n"})]
        for r in self.drive(flow, origin=False):
            self.assertEqual((r.status_code, r.json()["detail"]), (403, "Cross-origin request refused"))


class TokenNeverKept(Harness):
    def test_the_requesters_token_is_nowhere(self):
        responses = []

        async def flow(c):
            t = await self.ticket(c)
            responses.append(await self.submit(c, t))
        with self.assertLogs(level="DEBUG") as logs:
            self.drive(flow)
        stored = " ".join(k + " " + v.decode(errors="replace") for k, v in self.redis.data.items())
        self.assertNotIn(TOKEN, stored)
        db = self.Session()
        try:
            dump = "\n".join(repr(tuple(row)) for table in Base.metadata.sorted_tables
                             for row in db.execute(table.select()).fetchall())
        finally:
            db.close()
        self.assertNotIn(TOKEN, dump)
        self.assertNotIn(TOKEN, "\n".join(logs.output))
        for r in responses:
            self.assertNotIn(TOKEN, r.text + repr(r.headers))
        self.create_session.assert_not_awaited()


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class EveryCaller(SettingsGateBase):
    """Through the whole app and the real session lookup: the public routes
    answer a signed-out visitor, a member and an admin alike, sign nobody in,
    and are rate limited per client address."""

    ROUTES = [(BASE + "/pin", None), (BASE + "/identify", {"pin_id": 1}), (BASE, {"name": "Sam", "note": "Hi"})]

    def setUp(self):
        super().setUp()
        self.redis = FakeRedis()
        self.create_session = mock.AsyncMock()
        for p in (mock.patch.object(session_manager, "get_redis", mock.AsyncMock(return_value=self.redis)),
                  mock.patch.object(session_manager, "create_session", self.create_session)):
            p.start()
            self.addCleanup(p.stop)

    def open_up(self):
        helpers.put(self.db, "access_requests.enabled", "true")
        helpers.put(self.db, "integration.plex.url", "http://192.168.1.2:32400")

    def test_closed_for_everyone(self):
        for who, c in self.callers().items():
            for path, body in self.ROUTES:
                with self.subTest(who=who, path=path):
                    r = c.post(path, json=body)
                    self.assertEqual((r.status_code, r.json()["detail"]), (403, access.CLOSED))

    def test_open_answers_everyone_alike_and_signs_nobody_in(self):
        self.open_up()
        answers = {}
        for who, c in self.callers().items():
            got = []
            for path, body in self.ROUTES:
                r = c.post(path, json=body)
                got.append((r.status_code, r.json().get("detail")))
                self.assertNotIn(settings.session_cookie_name + "=", r.headers.get("set-cookie", ""))
            answers[who] = got
        # plex.tv is offline in this harness, so the PIN can't be made.
        want = [(503, access.PLEX_DOWN), (400, access.EXPIRED), (400, access.TIMED_OUT)]
        self.assertEqual(answers, {"signed out": want, "member": want, "admin": want})
        self.create_session.assert_not_awaited()

    def limited(self, path, body, allowed):
        restore = _private_limiter()
        self.addCleanup(restore)
        helpers.set_rate_limits(True)
        c = self.client()
        return [c.post(path, json=body).status_code for _ in range(allowed + 1)]

    def test_pin_five_a_minute(self):
        self.open_up()
        codes = self.limited(BASE + "/pin", None, 5)
        self.assertNotIn(429, codes[:5])
        self.assertEqual(codes[5], 429)

    def test_pin_also_twenty_an_hour(self):
        src = Path(access.__file__).read_text(encoding="utf-8")
        self.assertIn('@limiter.limit("5/minute;20/hour")\nasync def start_pin(', src)

    def test_identify_sixty_a_minute(self):
        self.open_up()
        codes = self.limited(BASE + "/identify", {"pin_id": 1}, 60)
        self.assertEqual(set(codes[:60]), {400})
        self.assertEqual(codes[60], 429)

    def test_submit_five_an_hour(self):
        self.open_up()
        codes = self.limited(BASE, {"name": "Sam", "note": "Hi"}, 5)
        self.assertEqual(set(codes[:5]), {400})
        self.assertEqual(codes[5], 429)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run them and see them fail**

Run: `ssh webserver "docker exec -i webservarr-dev python - -v" < app/tests/test_access_public.py`
Expected: `ImportError: cannot import name 'access_requests' from 'app.routers'`.

- [ ] **Step 3: The three-way membership check**

In `app/routers/auth.py`, replace `_user_has_server_access` with:

```python
async def _server_membership(plex_token: str, db: Session) -> str:
    """Whether the Plex user behind `plex_token` can access the configured
    server (owner, or a shared or home user): "member", "not_member", or
    "unknown" when that can't be told (the server's id can't be found, or
    plex.tv errs). Request access reads "unknown" as Plex being down, never
    as "not a member"."""
    if not plex_token:
        return "not_member"

    authorized_ids = await _fetch_configured_server_identifiers(db)
    if not authorized_ids:
        logger.error(
            "Plex membership check: could not determine the configured server's "
            "identifier (fail closed)"
        )
        return "unknown"

    try:
        user_ids = await _fetch_server_identifiers_for_token(plex_token, _plex_client_headers(db))
    except Exception as e:
        logger.error("Plex membership check: failed to fetch the user's servers: %s", str(e))
        return "unknown"

    if authorized_ids & user_ids:
        return "member"

    logger.warning("Plex membership check: account has no access to the configured server")
    return "not_member"


async def _user_has_server_access(plex_token: str, db: Session) -> bool:
    """True if the Plex user behind `plex_token` can access the configured
    server. Fails CLOSED: any error, or an inability to positively confirm
    membership, returns False."""
    return await _server_membership(plex_token, db) == "member"
```

- [ ] **Step 4: The public router**

Create `app/routers/access_requests.py`:

```python
"""
Request access from the sign-in page (docs/superpowers/specs/2026-10-10-request-access-design.md,
section 6).

Public, no session: POST /api/access-requests/pin, POST /api/access-requests/identify and
POST /api/access-requests. Each refuses with 403 unless the switch is on and Plex is set up, before
it does anything else. The flow proves a Plex account with the Plex PIN window, as the Plex sign-in
does, in a namespace of its own (access_pin:* and its own cookies), so a sign-in PIN can't complete
a request and a request PIN can't sign anyone in. It never makes a session. The requester's Plex
token lives only in identify's local variables: never in Redis, the database, a log or a response.
"""
import asyncio
import hmac
import json
import logging
import secrets
from typing import Dict, Tuple
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import session_manager
from app.config import settings
from app.database import get_db
from app.integrations import plex_share
from app.limiter import limiter
from app.routers import auth, plex_auth
from app.routers.player import Text, require_encodable_body, require_same_origin
from app.services import access_requests as svc

logger = logging.getLogger(__name__)
router = APIRouter()

PLEX_TIMEOUT = 5.0
COOKIE_PATH = "/api/access-requests"
PIN_COOKIE = "webservarr_access_pin"
TICKET_COOKIE = "webservarr_access_ticket"
PIN_TTL = 300            # the PIN and its cookie, as the Plex sign-in
PIN_CLAIM_TTL = 60       # one identify at a time per PIN
TICKET_TTL = 900         # from identify to submit
SUBMIT_LOCK = "access_requests:submit"
SUBMIT_LOCK_TTL = 10
SUBMIT_LOCK_TRIES = 50
SUBMIT_LOCK_WAIT = 0.1

# The card shows these as they are, except NOT_YET, which it matches.
CLOSED = "Access requests are closed."
EXPIRED = "That Plex sign-in expired. Start again."
NOT_YET = "PIN not yet authorized. Try again."
BUSY = "This Plex sign-in is already being checked."
PLEX_DOWN = "Plex isn't answering right now. Try again in a minute."
TIMED_OUT = "Your Plex check timed out. Start again."
FULL = "We're not taking new requests right now. Try again later."
SUBMIT_BUSY = "Lots of requests are arriving at once. Try again in a moment."


class IdentifyBody(BaseModel):
    pin_id: int = Field(ge=1, le=2 ** 53 - 1)


class SubmitBody(BaseModel):
    # Generous raw caps; clean_form applies the real ones (80 and 1000, trimmed).
    name: Text = Field(max_length=200)
    note: Text = Field(max_length=4000)


def _hash(value: str) -> str:
    return plex_auth._hash_pin_nonce(value)


def _text(raw) -> str:
    return raw.decode() if isinstance(raw, (bytes, bytearray)) else (raw or "")


def _require_open(db: Session) -> None:
    if not svc.is_open(db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=CLOSED)


async def _create_pin(client_id: str) -> Tuple[int, str]:
    """A strong PIN on plex.tv: (id, code)."""
    try:
        async with httpx.AsyncClient(timeout=PLEX_TIMEOUT) as client:
            resp = await client.post("https://plex.tv/api/v2/pins", headers=plex_auth._plex_headers(client_id),
                                     data={"strong": "true"})
        data = resp.json() if resp.status_code == 201 else None
    except (httpx.HTTPError, ValueError):
        data = None
    pin_id = data.get("id") if isinstance(data, dict) else None
    code = data.get("code") if isinstance(data, dict) else None
    if not isinstance(pin_id, int) or not isinstance(code, str) or not code:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=PLEX_DOWN)
    return pin_id, code


async def _pin_token(pin_id: int, client_id: str) -> str:
    """The PIN's Plex token once the person has signed in to Plex, else ""."""
    try:
        async with httpx.AsyncClient(timeout=PLEX_TIMEOUT) as client:
            resp = await client.get(f"https://plex.tv/api/v2/pins/{pin_id}", headers=plex_auth._plex_headers(client_id))
        data = resp.json() if resp.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        data = None
    if not isinstance(data, dict):
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=PLEX_DOWN)
    token = data.get("authToken")
    return token if isinstance(token, str) else ""


async def _account_state(db: Session, account_id: str) -> Dict[str, str]:
    """invited when Plex lists a pending invite for this account on our
    server, else the row's state. A failed invite lookup skips that step."""
    try:
        if await plex_share.find_share(account_id) == "pending":
            return {"state": "invited"}
    except plex_share.PlexShareUnavailable:
        pass
    return svc.state_for(db, account_id, svc.now_utc())


async def _take_submit_lock(r) -> str:
    """The submit lock's owner token, or "" when it stayed busy."""
    owner = secrets.token_hex(8)
    for _ in range(SUBMIT_LOCK_TRIES):
        if await r.set(SUBMIT_LOCK, owner, nx=True, ex=SUBMIT_LOCK_TTL):
            return owner
        await asyncio.sleep(SUBMIT_LOCK_WAIT)
    return ""


async def _drop_submit_lock(r, owner: str) -> None:
    if _text(await r.get(SUBMIT_LOCK)) == owner:
        await r.delete(SUBMIT_LOCK)


@router.post("/pin", dependencies=[Depends(require_same_origin)])
@limiter.limit("5/minute;20/hour")
async def start_pin(request: Request, response: Response, db: Session = Depends(get_db)):
    """A Plex PIN bound to this browser: the nonce in an HttpOnly cookie,
    only its hash in Redis, as the Plex sign-in does."""
    _require_open(db)
    client_id = plex_auth._get_plex_client_id(db)
    pin_id, code = await _create_pin(client_id)
    nonce = secrets.token_urlsafe(32)
    r = await session_manager.get_redis()
    await r.setex(f"access_pin:{pin_id}", PIN_TTL, _hash(nonce))
    response.set_cookie(key=PIN_COOKIE, value=nonce, max_age=PIN_TTL, httponly=True,
                        secure=settings.cookie_secure, samesite="lax", path=COOKIE_PATH)
    # As plex_start: the address the browser is really on, behind a TLS proxy too.
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    forward = f"{scheme}://{request.url.netloc}/auth/plex-callback-page?for=access"
    auth_url = "https://app.plex.tv/auth#?" + urlencode({
        "clientID": client_id, "code": code, "forwardUrl": forward, "context[device][product]": "WebServarr",
    })
    logger.info("Access request PIN started: pin_id=%s", pin_id)
    return {"pin_id": pin_id, "auth_url": auth_url}


@router.post("/identify", dependencies=[Depends(require_same_origin), Depends(require_encodable_body)])
@limiter.limit("60/minute")
async def identify(request: Request, body: IdentifyBody, response: Response, db: Session = Depends(get_db)):
    """Who the PIN proved, and where their request stands (spec section 6)."""
    _require_open(db)
    pin_id = body.pin_id
    r = await session_manager.get_redis()
    pin_key = f"access_pin:{pin_id}"
    stored = _text(await r.get(pin_key))
    nonce = request.cookies.get(PIN_COOKIE) or ""
    # One error whether the PIN is unknown, expired or another browser's, so
    # this is no oracle for issued PIN ids (as plex_callback).
    if not (stored and nonce and hmac.compare_digest(_hash(nonce), stored)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EXPIRED)
    claim = f"access_pin_claim:{pin_id}"
    if not await r.set(claim, "1", nx=True, ex=PIN_CLAIM_TTL):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=BUSY)
    try:
        client_id = plex_auth._get_plex_client_id(db)
        token = await _pin_token(pin_id, client_id)
        if not token:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=NOT_YET)
    except BaseException:
        await r.delete(claim)
        raise
    # The PIN is used up: it can't be identified twice.
    await r.delete(pin_key)
    response.delete_cookie(key=PIN_COOKIE, path=COOKIE_PATH)

    # The token is used for these two calls only and goes with this function.
    account = await auth._fetch_plex_account(token, plex_auth._plex_headers(client_id))
    account_id = str(account.get("id") or "")
    membership = await auth._server_membership(token, db) if account_id else "unknown"
    if membership == "unknown":
        logger.warning("Access request identify: Plex couldn't answer (account=%s)", account_id or "unknown")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=PLEX_DOWN)

    username = str(account.get("username") or account.get("title") or "")[:100]
    avatar = svc.safe_avatar_url(account.get("thumb"))
    state = {"state": "member"} if membership == "member" else await _account_state(db, account_id)
    if state["state"] == "new":
        ticket = secrets.token_urlsafe(32)
        await r.setex(f"access_ticket:{_hash(ticket)}", TICKET_TTL, json.dumps({
            "plex_account_id": account_id, "plex_username": username,
            "plex_email": str(account.get("email") or "")[:254], "plex_avatar_url": avatar,
        }))
        response.set_cookie(key=TICKET_COOKIE, value=ticket, max_age=TICKET_TTL, httponly=True,
                            secure=settings.cookie_secure, samesite="strict", path=COOKIE_PATH)
    logger.info("Access request identify: account=%s state=%s", account_id, state["state"])
    return {**state, "username": username, "avatar_url": avatar}


@router.post("", dependencies=[Depends(require_same_origin), Depends(require_encodable_body)])
@limiter.limit("5/hour")
async def submit(request: Request, body: SubmitBody, response: Response, db: Session = Depends(get_db)):
    """Make the request with the ticket identify gave (spec section 6). The
    form is checked before the ticket is used, so a typo costs no Plex
    sign-in; the checks and the insert run under one lock across workers."""
    _require_open(db)
    try:
        name, note = svc.clean_form(body.name, body.note)
    except svc.FormProblem as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from None
    ticket = request.cookies.get(TICKET_COOKIE) or ""
    if not ticket:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=TIMED_OUT)
    r = await session_manager.get_redis()
    owner = await _take_submit_lock(r)
    if not owner:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=SUBMIT_BUSY)
    try:
        raw = await r.getdel(f"access_ticket:{_hash(ticket)}")
        if not raw:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=TIMED_OUT)
        account = json.loads(_text(raw))
        try:
            result, row = svc.place(db, account, name, note, svc.now_utc())
        except svc.CapReached:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=FULL) from None
    finally:
        await _drop_submit_lock(r, owner)
    response.delete_cookie(key=TICKET_COOKIE, path=COOKIE_PATH)
    if row is not None:
        logger.info("Access request %s made: account=%s", row.id, row.plex_account_id)
        await svc.notify_admins(r, db, row)
    else:
        logger.info("Access request not made: account=%s state=%s", account.get("plex_account_id"), result["state"])
    return result
```

In `app/main.py`, add `access_requests` to the `from app.routers import ...` line and, after the `plex_auth` line:

```python
app.include_router(access_requests.router, prefix="/api/access-requests", tags=["Access requests"])
```

- [ ] **Step 5: The callback page's access branch, test first**

Create `app/tests/js/plex_callback.mjs`:

```js
// The Plex hand-back page (plex-callback.js) for both flows: in a popup it
// tells the page that opened it which flow finished, on this origin only;
// as a redirect it goes back to the login page with the matching query. Only
// for=access exactly is the request flow; anything else is the sign-in.
// Run: node app/tests/js/plex_callback.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '../../static/js/plex-callback.js'), 'utf8');

let failed = 0;
let total = 0;
function check(what, ok, info) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${what}` + (info === undefined ? '' : ` (${JSON.stringify(info)})`));
  }
}

function run(url, popup) {
  const u = new URL(url);
  const posted = [];
  let closed = false;
  const location = { origin: u.origin, search: u.search, href: url };
  const win = { location, opener: popup ? { postMessage: (m, o) => posted.push({ m, o }) } : null,
                close() { closed = true; } };
  new Function('window', 'URLSearchParams', SRC)(win, URLSearchParams);
  return { posted, closed, href: location.href };
}

const PAGE = 'https://ws.test/auth/plex-callback-page';
const SIGN_IN = [PAGE, PAGE + '?for=ACCESS', PAGE + '?for=access2', PAGE + '?for=access%20', PAGE + '?x=for%3Daccess'];
for (const url of SIGN_IN) {
  const p = run(url, true);
  check(`${url}: popup says plex-auth-complete`, p.posted.length === 1 && p.posted[0].m.type === 'plex-auth-complete' &&
    p.posted[0].o === 'https://ws.test' && p.closed, p);
  const r = run(url, false);
  check(`${url}: redirect to sign-in`, r.href === '/login?plex_auth=complete', r.href);
}
const ACCESS = [PAGE + '?for=access', PAGE + '?for=access&x=1'];
for (const url of ACCESS) {
  const p = run(url, true);
  check(`${url}: popup says plex-access-complete`, p.posted.length === 1 && p.posted[0].m.type === 'plex-access-complete' &&
    p.posted[0].o === 'https://ws.test' && p.closed, p);
  const r = run(url, false);
  check(`${url}: redirect to the request card`, r.href === '/login?access_request=complete', r.href);
}

console.log(`${total - failed}/${total} plex callback cases pass`);
if (failed) process.exit(1);
```

Run: `node app/tests/js/plex_callback.mjs`
Expected: the `?for=access` cases FAIL (the page doesn't know the access flow yet).

Then change `app/static/js/plex-callback.js`:

```js
/**
 * WebServarr: Plex sign-in hand-back (/auth/plex-callback-page)
 *
 * Plex sends the sign-in popup back to this page. In the popup it tells the
 * login page that opened it and closes; opened as a redirect instead (phones),
 * it returns to the login page, which finishes the sign-in from there.
 *
 * The same page ends the request access flow's Plex check
 * (docs/superpowers/specs/2026-10-10-request-access-design.md): its address
 * then says for=access, that exact value only, and the login page's request
 * card takes it from there. Anything else is the sign-in.
 *
 * The first thing in the page's <head>, ahead of every stylesheet: a pending
 * stylesheet holds back the classic scripts after it, and a slow one must
 * never keep the popup open. It needs no element of the page.
 *
 * The message is only for this origin: the login page that opened the popup
 * is on it, and so is this page (Plex returns to the app's own address).
 */
(function () {
  'use strict';
  var forAccess = new URLSearchParams(window.location.search).get('for') === 'access';
  if (window.opener) {
    window.opener.postMessage({ type: forAccess ? 'plex-access-complete' : 'plex-auth-complete' }, window.location.origin);
    window.close();
  } else {
    window.location.href = forAccess ? '/login?access_request=complete' : '/login?plex_auth=complete';
  }
})();
```

Add `node app/tests/js/plex_callback.mjs` to the end of `package.json` `test:js` (`... && node app/tests/js/settings_frost.mjs && node app/tests/js/plex_callback.mjs`) and as a new line at the end of the `js-checks` run list in `.github/workflows/docker-publish.yml`.

Run: `node app/tests/js/plex_callback.mjs`
Expected: `14/14 plex callback cases pass`.

- [ ] **Step 6: Rebuild the CSS stamp**

Run: `npm run build:css`
Expected: `app/static/css/app.css` changes.

- [ ] **Step 7: Commit**

```bash
git add app/routers/auth.py app/routers/access_requests.py app/main.py app/static/js/plex-callback.js app/static/css/app.css package.json .github/workflows/docker-publish.yml app/tests/test_access_public.py app/tests/js/plex_callback.mjs
git commit -m "feat(access): public routes to prove a Plex account and ask for access, with no session"
```

- [ ] **Step 8: Deploy to dev and run the tests**

Deploy sequence with restart. Run on dev: `app.tests.test_access_public`, then `app.tests.test_same_origin_writes`, `app.tests.test_plex_pin_claim`, `app.tests.test_ticket_claim_signin`, `app.tests.test_ticket_identity` (each its own command), then the full suite; locally `npm run test:js`. Expected: all green. CI green.

### Task 8: Admin routes and the dev kit's seeded requests

**Files:**
- Modify: `app/services/access_requests.py` (`admin_view`, `listing`, `pending_count`, `deny`, `mark_approved`, `record_share`)
- Modify: `app/routers/access_requests.py` (add `admin_router`)
- Modify: `app/main.py` (register `admin_router` under `/api/admin`)
- Modify: `scripts/devkit/devkit.py`, `scripts/devkit/README.md`, `scripts/devkit/test_devkit.py`
- Test: `app/tests/test_access_admin.py`

**Interfaces:**
- Consumes: Task 4's model and service; Task 5's `list_libraries`, `share_server`, `PlexShareUnavailable`; `tickets.account_identity`; `require_admin`.
- Produces (used by Task 10):
  - `GET /api/admin/access-requests` returns `{pending: [Row], decided: [Row], blocked: [Row]}`: pending oldest first; decided (approved and denied) from the last 30 days, newest first; blocked newest first. `Row` = `{id, plex_username, plex_email, avatar_url, name, note, status, share_state, share_error, library_keys: [str], created_at, decided_at, can_ask_after}` (times ISO with Z or null). The Plex account id is never sent.
  - `GET /api/admin/access-requests/count` returns `{pending: int}`.
  - `GET /api/admin/access-requests/libraries` returns `{libraries: [{key, title, type}]}` or 503 with Plex's reason.
  - `POST /api/admin/access-requests/{id}/approve` `{library_keys: [str]}` returns `Row` (approved, with `share_state` and `share_error`). 404 gone, 409 not pending or being approved, 422 keys not from the list, 503 libraries unavailable.
  - `POST /api/admin/access-requests/{id}/deny` `{block: bool}` returns `Row`. 404, 409 not pending.
  - `POST /api/admin/access-requests/{id}/unblock` returns `{ok: true}`. 404, 409 not blocked.
  - Dev kit: `seed-access --identity plex:9900NN [--status pending|approved|denied|blocked] [--name] [--note] [--minutes-ago N] [--share-state shared|existing|failed] [--share-error TEXT]`; `cleanup` also deletes the reserved range's access requests.

- [ ] **Step 1: Write the failing tests**

Create `app/tests/test_access_admin.py`:

```python
"""
Settings > Access requests on the server (spec section 6, admin): the list, the count, the
libraries, approve (one share, approval final even when the share fails), deny, block and unblock.
Through the whole app and the real session lookup, so signed-out callers get 401 and members 403.
The routes work with the feature switched off. Plex is faked at the share client.
"""
import asyncio  # noqa: F401
import json
import unittest
from datetime import timedelta
from unittest import mock

try:
    import httpx  # noqa: F401
    from fastapi import FastAPI  # noqa: F401
    HAVE_APP = True
except ImportError:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

if HAVE_APP:
    from app.auth import session_manager
    from app.integrations import plex_share
    from app.models import AccessRequest
    from app.services import access_requests as svc
    from app.tests import helpers
    from app.tests.test_access_public import FakeRedis
    from app.tests.test_settings_gate import ADMIN_SID, MEMBER_SID, SettingsGateBase, _admin_operations

ADMIN = {**helpers.ADMIN, "auth_method": "plex", "user_id": "7", "plex_account_id": "7"} if HAVE_APP else {}
LIBS = [{"key": "1", "title": "Movies", "type": "movie"}, {"key": "2", "title": "TV", "type": "show"}]
API = "/api/admin/access-requests"


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class AdminRoutes(SettingsGateBase):
    def setUp(self):
        super().setUp()
        sessions = {ADMIN_SID: dict(ADMIN), MEMBER_SID: dict(helpers.MEMBER)}

        async def get_session(session_id):
            return sessions.get(session_id)
        self.redis = FakeRedis()
        self.libraries = mock.AsyncMock(return_value=[dict(x) for x in LIBS])
        self.share = mock.AsyncMock(return_value=("shared", None))
        for p in (mock.patch.object(session_manager, "get_session", side_effect=get_session),
                  mock.patch.object(session_manager, "get_redis", mock.AsyncMock(return_value=self.redis)),
                  mock.patch.object(plex_share, "list_libraries", self.libraries),
                  mock.patch.object(plex_share, "share_server", self.share)):
            p.start()
            self.addCleanup(p.stop)
        self.now = svc.now_utc().replace(microsecond=0)
        self.admin = self.client(ADMIN_SID)

    def add(self, account_id, status, minutes_ago=0, **kw):
        at = self.now - timedelta(minutes=minutes_ago)
        row = AccessRequest(plex_account_id=account_id, plex_username="user" + account_id,
                            plex_email=f"u{account_id}@example.com", name="Name " + account_id,
                            note="Line one\n<b>not bold</b>", status=status, created_at=at, **kw)
        self.db.add(row)
        self.db.commit()
        return row.id

    def row(self, rid):
        self.db.expire_all()
        return self.db.get(AccessRequest, rid)

    # ---- who may call ----

    def test_signed_out_401_member_403(self):
        rid = self.add("1", "pending")
        routes = [("get", API), ("get", API + "/count"), ("get", API + "/libraries"),
                  ("post", f"{API}/{rid}/approve"), ("post", f"{API}/{rid}/deny"), ("post", f"{API}/{rid}/unblock")]
        for method, path in routes:
            with self.subTest(path=path):
                self.assertEqual(self.client().request(method, path, json={}).status_code, 401)
                r = self.client(MEMBER_SID).request(method, path, json={})
                self.assertEqual((r.status_code, r.json()["detail"]), (403, "Admin access required"))
        self.assertEqual(self.row(rid).status, "pending")
        self.share.assert_not_awaited()

    def test_the_settings_gate_sweep_covers_them(self):
        found = set(_admin_operations())
        for op in (("get", API), ("get", API + "/count"), ("get", API + "/libraries"),
                   ("post", API + "/{request_id}/approve"), ("post", API + "/{request_id}/deny"),
                   ("post", API + "/{request_id}/unblock")):
            self.assertIn(op, found)

    # ---- reading ----

    def test_the_list(self):
        old = self.add("1", "pending", minutes_ago=60)
        new = self.add("2", "pending", minutes_ago=5)
        approved = self.add("3", "approved", decided_at=self.now - timedelta(days=1), share_state="failed",
                            share_error="Plex refused the share (HTTP 400)", library_keys='["1"]')
        denied = self.add("4", "denied", decided_at=self.now - timedelta(hours=1),
                          cooldown_until=self.now + timedelta(days=29))
        self.add("5", "approved", decided_at=self.now - timedelta(days=31))
        blocked = self.add("6", "blocked", decided_at=self.now - timedelta(days=200))
        r = self.admin.get(API)
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual([x["id"] for x in body["pending"]], [old, new])
        self.assertEqual([x["id"] for x in body["decided"]], [denied, approved])
        self.assertEqual([x["id"] for x in body["blocked"]], [blocked])
        first = body["pending"][0]
        self.assertEqual(first["note"], "Line one\n<b>not bold</b>")
        self.assertEqual(set(first), {"id", "plex_username", "plex_email", "avatar_url", "name", "note", "status",
                                      "share_state", "share_error", "library_keys", "created_at", "decided_at",
                                      "can_ask_after"})
        failed = body["decided"][1]
        self.assertEqual((failed["share_state"], failed["share_error"], failed["library_keys"]),
                         ("failed", "Plex refused the share (HTTP 400)", ["1"]))
        self.assertNotIn('"plex_account_id"', r.text)

    def test_the_count(self):
        self.add("1", "pending")
        self.add("2", "pending")
        self.add("3", "blocked", decided_at=self.now)
        self.assertEqual(self.admin.get(API + "/count").json(), {"pending": 2})

    def test_the_libraries(self):
        self.assertEqual(self.admin.get(API + "/libraries").json(), {"libraries": LIBS})
        self.libraries.side_effect = plex_share.PlexShareUnavailable("Plex didn't answer")
        r = self.admin.get(API + "/libraries")
        self.assertEqual((r.status_code, r.json()["detail"]), (503, "Plex didn't answer"))

    def test_works_with_the_feature_off(self):
        helpers.put(self.db, "access_requests.enabled", "false")
        rid = self.add("1", "pending")
        self.assertEqual(self.admin.get(API + "/count").json(), {"pending": 1})
        self.assertEqual(self.admin.post(f"{API}/{rid}/deny", json={"block": False}).status_code, 200)

    # ---- approve ----

    def approve(self, rid, keys=("1",)):
        return self.admin.post(f"{API}/{rid}/approve", json={"library_keys": list(keys)})

    def test_approve_shares_once_and_records_it(self):
        rid = self.add("5551", "pending")
        r = self.approve(rid, ("2", "1"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["status"], r.json()["share_state"]), ("approved", "shared"))
        self.share.assert_awaited_once_with({"plex_account_id": "5551", "plex_username": "user5551"}, ["2", "1"])
        row = self.row(rid)
        self.assertEqual((row.status, row.decided_by, json.loads(row.library_keys), row.share_state),
                         ("approved", "plex:7", ["2", "1"], "shared"))
        self.assertEqual(self.approve(rid).status_code, 409)
        self.share.assert_awaited_once()
        self.assertNotIn(f"access_approve:{rid}", self.redis.data)

    def test_approval_is_saved_before_the_share_and_stays_when_it_fails(self):
        rid = self.add("5551", "pending")
        seen = []

        async def share(account, keys):
            seen.append(self.row(rid).status)
            return "failed", "Plex refused the share (HTTP 400)"
        self.share.side_effect = share
        r = self.approve(rid)
        self.assertEqual(seen, ["approved"])
        self.assertEqual((r.status_code, r.json()["status"], r.json()["share_state"], r.json()["share_error"]),
                         (200, "approved", "failed", "Plex refused the share (HTTP 400)"))

    def test_approve_refusals(self):
        rid = self.add("1", "pending")
        for keys in ([], ["9"], ["abc"], ["1", "x"]):
            with self.subTest(keys=keys):
                self.assertEqual(self.approve(rid, keys).status_code, 422)
        self.assertEqual(self.admin.post(f"{API}/{rid}/approve", json={"library_keys": ["1"] * 51}).status_code, 422)
        self.assertEqual(self.approve(9999).status_code, 404)
        done = self.add("2", "denied", decided_at=self.now, cooldown_until=self.now + timedelta(days=30))
        self.assertEqual(self.approve(done).status_code, 409)
        self.share.assert_not_awaited()
        self.assertEqual(self.row(rid).status, "pending")

    def test_plex_down_leaves_the_request_pending(self):
        rid = self.add("1", "pending")
        self.libraries.side_effect = plex_share.PlexShareUnavailable("Plex didn't answer")
        r = self.approve(rid)
        self.assertEqual((r.status_code, r.json()["detail"]), (503, "Plex didn't answer"))
        self.assertEqual(self.row(rid).status, "pending")
        self.share.assert_not_awaited()

    def test_an_approve_in_flight_blocks_a_second(self):
        rid = self.add("1", "pending")
        self.redis.data[f"access_approve:{rid}"] = b"1"
        self.assertEqual(self.approve(rid).status_code, 409)
        self.assertEqual(self.row(rid).status, "pending")
        self.share.assert_not_awaited()

    def test_approve_needs_the_same_origin(self):
        rid = self.add("1", "pending")
        c = self.client(ADMIN_SID)
        c.headers.pop("Origin")
        r = c.post(f"{API}/{rid}/approve", json={"library_keys": ["1"]})
        self.assertEqual(r.status_code, 403)
        self.share.assert_not_awaited()

    # ---- deny, block, unblock ----

    def test_deny_starts_the_cooldown(self):
        rid = self.add("1", "pending")
        r = self.admin.post(f"{API}/{rid}/deny", json={"block": False})
        self.assertEqual(r.status_code, 200, r.text)
        row = self.row(rid)
        self.assertEqual((row.status, row.decided_by), ("denied", "plex:7"))
        self.assertLessEqual(abs((row.cooldown_until - row.decided_at) - svc.COOLDOWN), timedelta(seconds=1))
        self.assertEqual(self.admin.post(f"{API}/{rid}/deny", json={"block": True}).status_code, 409)

    def test_block_and_unblock(self):
        rid = self.add("1", "pending")
        self.assertEqual(self.admin.post(f"{API}/{rid}/deny", json={"block": True}).json()["status"], "blocked")
        self.assertIsNone(self.row(rid).cooldown_until)
        self.assertEqual(self.admin.post(f"{API}/{rid}/unblock").json(), {"ok": True})
        self.assertIsNone(self.row(rid))
        self.assertEqual(self.admin.post(f"{API}/{rid}/unblock").status_code, 404)
        pending = self.add("2", "pending")
        self.assertEqual(self.admin.post(f"{API}/{pending}/unblock").status_code, 409)

    def test_deny_takes_a_real_boolean(self):
        rid = self.add("1", "pending")
        self.assertEqual(self.admin.post(f"{API}/{rid}/deny", json={"block": "yes"}).status_code, 422)
        self.assertEqual(self.row(rid).status, "pending")


if __name__ == "__main__":
    unittest.main()
```

Add to `scripts/devkit/test_devkit.py` (after the `Cleanup` class):

```python
ACCESS = ("CREATE TABLE access_requests (id INTEGER PRIMARY KEY, plex_account_id TEXT UNIQUE NOT NULL, "
          "plex_username TEXT NOT NULL, plex_email TEXT NOT NULL DEFAULT '', plex_avatar_url TEXT NOT NULL DEFAULT '', "
          "name TEXT NOT NULL, note TEXT NOT NULL, status TEXT NOT NULL, share_state TEXT, share_error TEXT, "
          "library_keys TEXT, created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, cooldown_until TEXT)")


class AccessSeeding(WithDatabase):
    def with_access(self) -> sqlite3.Connection:
        conn = self.database()
        conn.execute(ACCESS)
        return conn

    def rows(self, conn):
        return conn.execute("SELECT plex_account_id, plex_username, status, share_state, decided_at IS NOT NULL, "
                            "cooldown_until IS NOT NULL FROM access_requests ORDER BY plex_account_id").fetchall()

    def test_one_row_per_identity_and_each_status(self):
        conn = self.with_access()
        now = datetime(2026, 10, 10, 12, 0, 0)
        devkit.seed_access(conn, "plex:990011", "pending", "A", "n", now=now)
        devkit.seed_access(conn, "plex:990011", "denied", "A", "n", now=now)
        devkit.seed_access(conn, "plex:990012", "approved", "B", "n", share_state="failed",
                           share_error="Plex refused the share (HTTP 400)", now=now)
        devkit.seed_access(conn, "plex:990013", "blocked", "C", "n", now=now)
        self.assertEqual(self.rows(conn), [("990011", "devkit-990011", "denied", None, 1, 1),
                                           ("990012", "devkit-990012", "approved", "failed", 1, 0),
                                           ("990013", "devkit-990013", "blocked", None, 1, 0)])

    def test_refusals_write_nothing(self):
        conn = self.with_access()
        for args in (("plex:12345", "pending"), ("plex:990011", "maybe")):
            with self.subTest(args=args), self.assertRaises(devkit.DevkitError):
                devkit.seed_access(conn, args[0], args[1], "A", "n")
        with self.assertRaises(devkit.DevkitError):
            devkit.seed_access(conn, "plex:990011", "pending", "A", "n", share_state="failed")
        self.assertEqual(self.rows(conn), [])

    def test_cleanup_takes_only_the_reserved_range(self):
        conn = self.with_access()
        for account_id in ("990011", "990099", "990100", "12345"):
            conn.execute("INSERT INTO access_requests (plex_account_id, plex_username, name, note, status, created_at) "
                         "VALUES (?, 'u', 'n', 'n', 'pending', 'now')", (account_id,))
        removed = devkit.delete_reserved_rows(conn)
        self.assertEqual(removed["access_requests"], 2)
        left = sorted(r[0] for r in conn.execute("SELECT plex_account_id FROM access_requests"))
        self.assertEqual(left, ["12345", "990100"])

    def test_cleanup_without_the_table(self):
        self.assertNotIn("access_requests", devkit.delete_reserved_rows(self.database()))
```

- [ ] **Step 2: Run them and see them fail**

Run: `ssh webserver "docker exec -i webservarr-dev python - -v" < app/tests/test_access_admin.py`
Expected: failures: the admin routes answer 404 (they don't exist yet; the import of `test_access_public` works once Task 7 is on dev).
Run: `python3 -m unittest discover -s scripts/devkit -t scripts/devkit`
Expected: `AttributeError: module 'devkit' has no attribute 'seed_access'` and a `KeyError: 'access_requests'`.

- [ ] **Step 3: The admin decisions in the service**

Append to `app/services/access_requests.py` (add `import json` and `List` to its imports):

```python
DECIDED_SHOWN = timedelta(days=30)   # how far back Settings lists approved and denied rows


def _keys(raw: Optional[str]) -> List[str]:
    try:
        keys = json.loads(raw) if raw else []
    except ValueError:
        return []
    return [k for k in keys if isinstance(k, str)] if isinstance(keys, list) else []


def admin_view(row: AccessRequest) -> Dict:
    """A row as Settings shows it. The Plex account id stays on the server."""
    return {
        "id": row.id, "plex_username": row.plex_username, "plex_email": row.plex_email,
        "avatar_url": row.plex_avatar_url, "name": row.name, "note": row.note, "status": row.status,
        "share_state": row.share_state, "share_error": row.share_error, "library_keys": _keys(row.library_keys),
        "created_at": utc_iso(row.created_at), "decided_at": utc_iso(row.decided_at),
        "can_ask_after": utc_iso(row.cooldown_until),
    }


def listing(db: Session, now: datetime) -> Dict[str, List[Dict]]:
    """Pending oldest first; approved and denied from the last 30 days and
    every blocked account, newest first."""
    q = db.query(AccessRequest)
    pending = q.filter(AccessRequest.status == "pending").order_by(AccessRequest.created_at.asc(), AccessRequest.id.asc())
    decided = (q.filter(AccessRequest.status.in_(("approved", "denied")), AccessRequest.decided_at.isnot(None),
                        AccessRequest.decided_at >= now - DECIDED_SHOWN)
               .order_by(AccessRequest.decided_at.desc(), AccessRequest.id.desc()))
    blocked = q.filter(AccessRequest.status == "blocked").order_by(AccessRequest.decided_at.desc(), AccessRequest.id.desc())
    return {"pending": [admin_view(r) for r in pending], "decided": [admin_view(r) for r in decided],
            "blocked": [admin_view(r) for r in blocked]}


def pending_count(db: Session) -> int:
    return db.query(AccessRequest).filter(AccessRequest.status == "pending").count()


def deny(db: Session, row: AccessRequest, block: bool, decided_by: str, now: datetime) -> None:
    """Denied (the account may ask again after COOLDOWN) or blocked for good."""
    row.status = "blocked" if block else "denied"
    row.decided_at = now
    row.decided_by = (decided_by or "")[:64] or None
    row.cooldown_until = None if block else now + COOLDOWN
    db.commit()


def mark_approved(db: Session, row: AccessRequest, keys: List[str], decided_by: str, now: datetime) -> None:
    """Approved, before the share is tried: approval is final either way."""
    row.status = "approved"
    row.decided_at = now
    row.decided_by = (decided_by or "")[:64] or None
    row.library_keys = json.dumps(keys)
    db.commit()


def record_share(db: Session, row: AccessRequest, state: str, error: Optional[str]) -> None:
    row.share_state = state
    row.share_error = (error or "")[:200] or None
    db.commit()
```

- [ ] **Step 4: The admin router**

Append to `app/routers/access_requests.py` (add `import re`, `from typing import List`, `from pydantic import StrictBool`, `from app.dependencies import require_admin`, `from app.models import AccessRequest` and `from app.routers.tickets import account_identity` to its imports; extend the module docstring's last line with: "Admin, under /api/admin and require_admin: the list, the count, the libraries, approve, deny and unblock. They work with the switch off, so requests already waiting can still be answered."):

```python
admin_router = APIRouter()

APPROVE_CLAIM_TTL = 60
LIBRARY_KEY = re.compile(r"[0-9]{1,10}")
GONE = "That request is gone."
ANSWERED = "That request was already answered."
PICK_LIBRARIES = "Pick libraries from the list."


class ApproveBody(BaseModel):
    library_keys: List[Text] = Field(min_length=1, max_length=50)


class DenyBody(BaseModel):
    block: StrictBool = False


def _row_in(db: Session, request_id: int, wanted: str) -> AccessRequest:
    row = db.get(AccessRequest, request_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=GONE)
    if row.status != wanted:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ANSWERED)
    return row


@admin_router.get("/access-requests")
async def list_access_requests(current_user: dict = Depends(require_admin), db: Session = Depends(get_db)):
    return svc.listing(db, svc.now_utc())


@admin_router.get("/access-requests/count")
async def count_access_requests(current_user: dict = Depends(require_admin), db: Session = Depends(get_db)):
    return {"pending": svc.pending_count(db)}


@admin_router.get("/access-requests/libraries")
async def access_libraries(current_user: dict = Depends(require_admin)):
    try:
        return {"libraries": await plex_share.list_libraries()}
    except plex_share.PlexShareUnavailable as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from None


@admin_router.post("/access-requests/{request_id}/approve",
                   dependencies=[Depends(require_same_origin), Depends(require_encodable_body)])
async def approve_access_request(request_id: int, body: ApproveBody, current_user: dict = Depends(require_admin),
                                 db: Session = Depends(get_db)):
    """Approve and share the server with that account and the ticked
    libraries. Approval is final even when Plex refuses the share; the row
    then says why, and the admin can share by hand."""
    row = _row_in(db, request_id, "pending")
    keys = list(dict.fromkeys(body.library_keys))
    if not all(LIBRARY_KEY.fullmatch(k) for k in keys):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=PICK_LIBRARIES)
    try:
        on_server = {lib["key"] for lib in await plex_share.list_libraries()}
    except plex_share.PlexShareUnavailable as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from None
    if not set(keys) <= on_server:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=PICK_LIBRARIES)
    r = await session_manager.get_redis()
    claim = f"access_approve:{request_id}"
    if not await r.set(claim, "1", nx=True, ex=APPROVE_CLAIM_TTL):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ANSWERED)
    try:
        db.refresh(row)
        if row.status != "pending":
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ANSWERED)
        svc.mark_approved(db, row, keys, account_identity(current_user), svc.now_utc())
        state, error = await plex_share.share_server(
            {"plex_account_id": row.plex_account_id, "plex_username": row.plex_username}, keys)
        svc.record_share(db, row, state, error)
    finally:
        await r.delete(claim)
    logger.info("Access request %s approved: account=%s share=%s", row.id, row.plex_account_id, state)
    return svc.admin_view(row)


@admin_router.post("/access-requests/{request_id}/deny",
                   dependencies=[Depends(require_same_origin), Depends(require_encodable_body)])
async def deny_access_request(request_id: int, body: DenyBody, current_user: dict = Depends(require_admin),
                              db: Session = Depends(get_db)):
    row = _row_in(db, request_id, "pending")
    svc.deny(db, row, body.block, account_identity(current_user), svc.now_utc())
    logger.info("Access request %s %s: account=%s", row.id, row.status, row.plex_account_id)
    return svc.admin_view(row)


@admin_router.post("/access-requests/{request_id}/unblock", dependencies=[Depends(require_same_origin)])
async def unblock_access_request(request_id: int, current_user: dict = Depends(require_admin),
                                 db: Session = Depends(get_db)):
    row = _row_in(db, request_id, "blocked")
    logger.info("Access request %s unblocked: account=%s", row.id, row.plex_account_id)
    db.delete(row)
    db.commit()
    return {"ok": True}
```

In `app/main.py`, after the `admin.router` line:

```python
app.include_router(access_requests.admin_router, prefix="/api/admin", tags=["Admin access requests"])
```

- [ ] **Step 5: The dev kit**

In `scripts/devkit/devkit.py`, after `require_not_in_library`:

```python
ACCESS_STATUSES = ("pending", "approved", "denied", "blocked")
SHARE_STATES = ("shared", "existing", "failed")


def seed_access(conn: sqlite3.Connection, identity: str, status: str, name: str, note: str,
                minutes_ago: int = 0, share_state: str | None = None, share_error: str | None = None,
                now: datetime | None = None) -> dict:
    """A request for access from a reserved identity (replacing any it has).
    Its username is devkit-<id>. Never approve one on a live site: approving
    shares the real Plex server with whoever holds that username, so live
    checks intercept the approve route."""
    require_reserved(identity)
    if status not in ACCESS_STATUSES:
        raise DevkitError(f"status must be one of {', '.join(ACCESS_STATUSES)}")
    if share_state is not None and (share_state not in SHARE_STATES or status != "approved"):
        raise DevkitError("--share-state is for an approved request only: shared, existing or failed")
    if minutes_ago < 0:
        raise DevkitError("--minutes-ago cannot be negative")
    account_id = identity.split(":", 1)[1]
    at = (now or datetime.now(timezone.utc).replace(tzinfo=None)) - timedelta(minutes=minutes_ago)
    stamp = at.strftime("%Y-%m-%d %H:%M:%S.000000")
    decided = None if status == "pending" else stamp
    cooldown = (at + timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S.000000") if status == "denied" else None
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("DELETE FROM access_requests WHERE plex_account_id = ?", (account_id,))
        conn.execute(
            "INSERT INTO access_requests (plex_account_id, plex_username, plex_email, plex_avatar_url, name, note, "
            "status, share_state, share_error, library_keys, created_at, decided_at, decided_by, cooldown_until) "
            "VALUES (?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (account_id, f"devkit-{account_id}", name, note, status, share_state, share_error,
             '["1"]' if status == "approved" else None, stamp, decided, "devkit" if decided else None, cooldown))
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")
    return {"identity": identity, "status": status, "share_state": share_state}
```

In `delete_reserved_rows`, before `except BaseException:`, add:

```python
        # Requests for access are keyed by the bare Plex account id.
        if conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'access_requests'").fetchone():
            count = 0
            for (account_id,) in conn.execute("SELECT plex_account_id FROM access_requests").fetchall():
                if is_reserved(f"plex:{account_id}"):
                    count += conn.execute("DELETE FROM access_requests WHERE plex_account_id = ?",
                                          (account_id,)).rowcount
            removed["access_requests"] = count
```

In `build_parser`, before the `cleanup` parser:

```python
    access = commands.add_parser("seed-access", help="seed a request for access from a test identity")
    access.add_argument("--identity", type=identity_arg, required=True)
    access.add_argument("--status", choices=ACCESS_STATUSES, default="pending")
    access.add_argument("--name", default="Devkit Person")
    # The default note has a second line and one 200-letter word, so a live
    # check sees line breaks kept and a long word wrapped at 390 wide.
    access.add_argument("--note", default="A test request from the dev kit.\nIt has a second line and one long word: "
                        + "w" * 200)
    access.add_argument("--minutes-ago", type=int, default=0)
    access.add_argument("--share-state", choices=SHARE_STATES)
    access.add_argument("--share-error")
```

In `run`, before `elif args.command == "cleanup":`:

```python
        elif args.command == "seed-access":
            print(json.dumps(seed_access(conn, args.identity, args.status, args.name, args.note,
                                         args.minutes_ago, args.share_state, args.share_error)))
```

In `scripts/devkit/README.md`, under Commands, add:

```bash
# Seed a request for access (Settings > Access requests). Its username is devkit-<id>.
# NEVER approve a seeded request on a live site: approving shares the real Plex server
# with whoever holds that username. Live checks intercept the approve route.
dk seed-access --identity plex:990011                       # pending
dk seed-access --identity plex:990012 --status approved --share-state failed --share-error "Plex refused the share (HTTP 400)"
dk seed-access --identity plex:990013 --status blocked
```

- [ ] **Step 6: Run the dev kit tests**

Run: `python3 -m unittest discover -s scripts/devkit -t scripts/devkit`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add app/services/access_requests.py app/routers/access_requests.py app/main.py scripts/devkit/devkit.py scripts/devkit/README.md scripts/devkit/test_devkit.py app/tests/test_access_admin.py
git commit -m "feat(access): admin routes to approve, deny and unblock, and seeded requests in the dev kit"
```

- [ ] **Step 8: Deploy to dev and run the tests**

Deploy sequence with restart. Run on dev: `app.tests.test_access_admin`, `app.tests.test_settings_gate`, `app.tests.test_same_origin_writes` (each its own command), then the full suite. Then seed and read one row to prove the dev kit on dev, each its own command:
`ssh webserver "docker exec -i webservarr-dev python - seed-access --identity plex:990011 < ~/webservarr-dev/scripts/devkit/devkit.py"`
`ssh webserver "docker exec -i webservarr-dev python - cleanup < ~/webservarr-dev/scripts/devkit/devkit.py"`
Expected: a JSON line, then `cleanup: rows deleted (... access_requests 1)`. CI green.

### Task 9: The sign-in card's request steps (after Jordan approves Task 3)

**Do not start until Jordan has approved the Task 3 mockup.** The class lists below are a starting point in the card's existing style; where the approved mockup differs, the mockup wins. The ids, `data-ra-*` hooks, words (unless Jordan changed them in the mockup) and behaviour are fixed by this task and its tests.

**Files:**
- Modify: `app/static/login.html` (the link, the steps, the error line, a style block, one script tag)
- Create: `app/static/js/login-request.js`
- Modify: `app/static/js/login.js` (one call at the end of `applyLoginBranding`)
- Modify: `app/static/css/app.css` (rebuilt), `package.json`, `.github/workflows/docker-publish.yml`
- Test: `app/tests/js/login_request.mjs`

**Interfaces:**
- Consumes: the three public routes and their details (Task 7); `auth_methods.request_access` (Task 4); the `plex-access-complete` message and `/login?access_request=complete` (Task 7).
- Produces: `window.WSRequestAccess.apply(theme)`, called by `login.js` whenever it applies the sign-in methods.

- [ ] **Step 1: Write the failing test**

Create `app/tests/js/login_request.mjs`:

```js
// The request access steps inside the sign-in card (login-request.js over
// login.html, with login.js as the page runs it), in happy-dom with a
// scripted server, a fake popup and a fake clock. Covers: the link only when
// the site takes requests; every step, its heading focused and announced;
// the popup path (the popup's message only, the popup closed early, the
// popup blocked and reopened, a second completion); the phone path (away
// and back, and back without the stored PIN); the form (the counter, the
// checks, one send for two presses); every server answer the card can get;
// each status message; Back to sign in and the browser's Back.
// Run: node app/tests/js/login_request.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const LOGIN_HTML = readFileSync(join(STATIC, 'login.html'), 'utf8');
const LOGIN_JS = readFileSync(join(STATIC, 'js/login.js'), 'utf8');
const REQUEST_JS = readFileSync(join(STATIC, 'js/login-request.js'), 'utf8');

let failed = 0;
let total = 0;
let current = '';
function check(what, ok, info) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${current}: ${what}` + (info === undefined ? '' : ` (${JSON.stringify(info)})`));
  }
}
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

const NOT_YET = 'PIN not yet authorized. Try again.';
const AUTH_URL = 'https://app.plex.tv/auth#?code=CODE';
const NEW = { state: 'new', username: 'newperson', avatar_url: 'https://plex.tv/users/abc/avatar?c=1' };

// answers: { 'POST /api/access-requests/pin': [reply, reply...] } taken in
// order, the last one repeating. A reply is { status, body } or 'offline'.
function server(answers) {
  const calls = [];
  const fetch = (url, init = {}) => {
    const key = (init.method || 'GET') + ' ' + String(url);
    calls.push({ key, body: init.body ? JSON.parse(init.body) : null });
    const list = answers[key];
    if (!list) return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('{}') });
    const reply = list.length > 1 ? list.shift() : list[0];
    if (reply === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
    const status = reply.status || 200;
    return Promise.resolve({ ok: status >= 200 && status < 300, status,
                             text: () => Promise.resolve(JSON.stringify(reply.body || {})) });
  };
  return { calls, fetch, sent: (key) => calls.filter((c) => c.key === key) };
}

function fakeTimers(w) {
  let now = 0;
  let ids = 0;
  const due = new Map();
  const def = (name, value) => Object.defineProperty(w, name, { value, configurable: true, writable: true });
  def('setTimeout', (fn, ms) => { const id = ++ids; due.set(id, { at: now + (ms || 0), fn, every: 0 }); return id; });
  def('setInterval', (fn, ms) => { const id = ++ids; due.set(id, { at: now + ms, fn, every: ms }); return id; });
  def('clearTimeout', (id) => due.delete(id));
  def('clearInterval', (id) => due.delete(id));
  return {
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of due) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        now = next[1].at;
        if (next[1].every) next[1].at += next[1].every; else due.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    }
  };
}

async function page(o = {}) {
  const w = new Window({ url: o.url || 'https://ws.test/login', width: o.width || 1440, height: 900 });
  const doc = w.document;
  doc.body.innerHTML = LOGIN_HTML.match(/<body[^>]*>([\s\S]*)<\/body>/)[1].replace(/<script\b[^>]*><\/script>/g, '');
  const clock = fakeTimers(w);
  const s = server(o.answers || {});
  w.fetch = s.fetch;
  const popups = [];
  const opened = [];
  w.open = (url, name, features) => {
    opened.push({ url, name, features });
    if (o.blockPopup && opened.length <= (o.blockPopup === 'always' ? 99 : 1)) return null;
    const p = { closed: false, location: { href: url }, close() { this.closed = true; } };
    popups.push(p);
    return p;
  };
  const assigned = [];
  w.location.assign = (url) => assigned.push(url);
  if (o.phone) Object.defineProperty(w.navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; Mobile)', configurable: true });
  if (o.storedPin !== undefined) w.sessionStorage.setItem('access_pin_id', o.storedPin);
  w.history.back = () => { w.history.replaceState(null, '', '/login'); w.dispatchEvent(new w.Event('popstate')); };
  w.WEBSERVARR_THEME = { auth_methods: { simple: true, plex: true, authentik: true, request_access: o.on !== false } };
  w.eval(REQUEST_JS);
  w.eval(LOGIN_JS);
  await flush();
  const t = {
    w, doc, s, clock, popups, opened, assigned,
    q: (sel) => doc.querySelector(sel),
    step() {
      if (doc.getElementById('requestAccess').hidden) return 'signin';
      const shown = Array.from(doc.querySelectorAll('[data-ra-step]')).filter((n) => !n.hidden);
      return shown.length === 1 ? shown[0].getAttribute('data-ra-step') : 'broken:' + shown.length;
    },
    heading() { const n = doc.querySelector(`[data-ra-step="${t.step()}"] [data-ra-heading]`); return n; },
    error: () => doc.getElementById('raError').textContent,
    live: () => doc.getElementById('raLive').textContent,
    async click(sel) { (typeof sel === 'string' ? doc.querySelector(sel) : sel).click(); await flush(); },
    async message(source, data, origin) {
      w.dispatchEvent(new w.MessageEvent('message', { data, origin: origin || 'https://ws.test', source }));
      await flush();
    },
    async close() { await w.happyDOM.abort(); w.close(); }
  };
  return t;
}

async function run(name, fn) {
  current = name;
  const made = [];
  try { await fn(async (o) => { const t = await page(o); made.push(t); return t; }); }
  catch (e) { failed += 1; total += 1; console.error(`FAIL ${name}: threw ${e && e.stack || e}`); }
  finally { while (made.length) await made.pop().close(); }
}

const PIN_OK = { body: { pin_id: 4242, auth_url: AUTH_URL } };
const IDENTIFY = 'POST /api/access-requests/identify';
const PIN = 'POST /api/access-requests/pin';
const SUBMIT = 'POST /api/access-requests';

function focusedOnHeading(t) { const h = t.heading(); return !!h && t.doc.activeElement === h; }

async function toWaiting(open, o = {}) {
  const t = await open({ answers: Object.assign({ [PIN]: [PIN_OK] }, o.answers || {}), blockPopup: o.blockPopup });
  await t.click('#requestAccessLink');
  await t.click('[data-ra-plex]');
  return t;
}

await run('feature off', async (open) => {
  const t = await open({ on: false, url: 'https://ws.test/login?access_request=complete#request-access', storedPin: '4242' });
  check('no link', t.q('#requestAccessLinkRow').hidden === true);
  check('the card is today\'s card', t.step() === 'signin' && !t.q('#loginForm').hidden);
  check('nothing asked of the server', t.s.calls.length === 0, t.s.calls);
});

await run('entering the flow', async (open) => {
  const t = await open();
  const before = t.w.history.length;
  check('the link shows', t.q('#requestAccessLinkRow').hidden === false);
  check('its words', t.q('#requestAccessLink').textContent.trim() === 'New here? Request access');
  await t.click('#requestAccessLink');
  check('S1', t.step() === 'intro');
  check('one history entry, #request-access', t.w.location.hash === '#request-access' && t.w.history.length === before + 1);
  check('the sign-in form is hidden', t.q('#loginForm').hidden === true);
  check('focus on the heading', focusedOnHeading(t));
  check('announced', t.live() === 'Request access', t.live());
  check('the heading can take focus', t.heading().getAttribute('tabindex') === '-1');
});

await run('back to sign in and the browser\'s Back', async (open) => {
  const t = await open();
  await t.click('#requestAccessLink');
  await t.click('[data-ra-step="intro"] [data-ra-back]');
  check('S0 again', t.step() === 'signin' && !t.q('#loginForm').hidden && !t.q('#requestAccessLinkRow').hidden);
  check('focus back on the link', t.doc.activeElement === t.q('#requestAccessLink'));
  check('the hash is gone', t.w.location.hash === '');
  await t.click('#requestAccessLink');
  t.w.history.back();
  await flush();
  check('Back returns to S0', t.step() === 'signin');
});

await run('popup: the message from the popup', async (open) => {
  const t = await toWaiting(open, { answers: { [IDENTIFY]: [{ body: NEW }] } });
  check('opened inside the click, then sent to Plex', t.opened.length === 1 && t.popups[0].location.href === AUTH_URL, t.opened);
  check('S2', t.step() === 'waiting' && focusedOnHeading(t) && t.live() === 'Waiting for Plex…', t.live());
  await t.message({}, { type: 'plex-access-complete' });
  await t.message(t.popups[0], { type: 'plex-auth-complete' });
  await t.message(t.popups[0], { type: 'plex-access-complete' }, 'https://evil.test');
  check('nobody else is heard', t.s.sent(IDENTIFY).length === 0);
  await t.message(t.popups[0], { type: 'plex-access-complete' });
  check('identify with the PIN', t.s.sent(IDENTIFY).length === 1 && t.s.sent(IDENTIFY)[0].body.pin_id === 4242);
  check('S3 with who they are', t.step() === 'form' && t.q('[data-ra-username]').textContent === 'newperson');
  check('the avatar', t.q('[data-ra-avatar]').getAttribute('src') === NEW.avatar_url && !t.q('[data-ra-avatar]').hidden);
  check('the popup is closed', t.popups[0].closed === true);
  await t.clock.advance(3000);
  check('no second identify after the popup closed', t.s.sent(IDENTIFY).length === 1);
});

await run('popup: closed before it finished', async (open) => {
  const t = await toWaiting(open, { answers: { [IDENTIFY]: [{ status: 400, body: { detail: NOT_YET } }] } });
  t.popups[0].closed = true;
  await t.clock.advance(1000);
  check('one identify', t.s.sent(IDENTIFY).length === 1);
  check('back to S1 with why', t.step() === 'intro' && t.error() === 'Plex sign-in was closed before it finished.', t.error());
});

await run('popup: a second completion is not an error', async (open) => {
  const t = await toWaiting(open, { answers: { [IDENTIFY]: [{ status: 409, body: { detail: 'busy' } }] } });
  await t.message(t.popups[0], { type: 'plex-access-complete' });
  check('stays on S2 with no error', t.step() === 'waiting' && t.error() === '', t.error());
});

await run('popup: Plex still finishing', async (open) => {
  const t = await toWaiting(open, { answers: { [IDENTIFY]: [{ status: 400, body: { detail: NOT_YET } }, { body: NEW }] } });
  await t.message(t.popups[0], { type: 'plex-access-complete' });
  check('waits, no error', t.step() === 'waiting' && t.error() === '');
  await t.clock.advance(2000);
  check('asked again, then the form', t.s.sent(IDENTIFY).length === 2 && t.step() === 'form');
});

await run('popup: blocked, then reopened from a click', async (open) => {
  const t = await toWaiting(open, { blockPopup: 'once', answers: { [IDENTIFY]: [{ body: NEW }] } });
  check('S2 says the window was blocked', t.step() === 'waiting' && t.error() === 'Your browser blocked the Plex window. Allow pop-ups, then press Reopen Plex sign-in.', t.error());
  check('the error sits just above the buttons', t.q('#raError').nextElementSibling === t.q('[data-ra-reopen]'));
  await t.click('[data-ra-reopen]');
  check('reopened at Plex', t.opened.length === 2 && t.opened[1].url === AUTH_URL && t.error() === '');
  await t.message(t.popups[0], { type: 'plex-access-complete' });
  check('then on to the form', t.step() === 'form');
});

await run('cancel while waiting', async (open) => {
  const t = await toWaiting(open);
  await t.click('[data-ra-cancel]');
  check('S1, the popup closed', t.step() === 'intro' && t.popups[0].closed === true);
  await t.message(t.popups[0], { type: 'plex-access-complete' });
  check('a late message is ignored', t.s.sent(IDENTIFY).length === 0);
});

await run('starting fails', async (open) => {
  for (const [reply, words] of [[{ status: 503, body: { detail: 'Plex isn\'t answering right now. Try again in a minute.' } }, 'Plex isn\'t answering right now. Try again in a minute.'],
                                [{ status: 429, body: { detail: 'Rate limit exceeded: 5 per 1 minute' } }, 'Too many tries. Wait a few minutes and try again.'],
                                ['offline', 'That didn’t go through. Check your connection and try again.']]) {
    const t = await open({ answers: { [PIN]: [reply] } });
    await t.click('#requestAccessLink');
    await t.click('[data-ra-plex]');
    check(`${words}: stays on S1`, t.step() === 'intro' && t.error() === words, t.error());
    check('the blank popup is closed again', t.popups.every((p) => p.closed));
  }
});

await run('closed while in the flow', async (open) => {
  const t = await toWaiting(open, { answers: { [IDENTIFY]: [{ status: 403, body: { detail: 'Access requests are closed.' } }] } });
  await t.message(t.popups[0], { type: 'plex-access-complete' });
  check('back to S0 with why, no link', t.step() === 'signin' && t.q('#requestAccessLinkRow').hidden === true &&
    t.error() === 'Access requests are closed.', t.error());
});

async function toForm(open, answers) {
  const t = await toWaiting(open, { answers: Object.assign({ [IDENTIFY]: [{ body: NEW }] }, answers) });
  await t.message(t.popups[0], { type: 'plex-access-complete' });
  return t;
}

function type(t, sel, text) { const n = t.q(sel); n.value = text; n.dispatchEvent(new t.w.Event('input')); }

await run('the form', async (open) => {
  const t = await toForm(open, { [SUBMIT]: [{ body: { state: 'pending', sent: true } }] });
  check('S3 focused and announced', focusedOnHeading(t) && t.live() === 'Request access');
  check('name field', t.q('#raName').getAttribute('autocomplete') === 'name' && t.q('label[for="raName"]'));
  check('note label', t.q('label[for="raNote"]').textContent.trim() === 'Who are you and how do you know us?');
  check('counter starts at 0/1000', t.q('#raCount').textContent === '0/1000');
  type(t, '#raNote', 'Hello');
  check('counter counts', t.q('#raCount').textContent === '5/1000');
  type(t, '#raName', '   ');
  await t.click('[data-ra-send]');
  check('an empty name is caught here', t.s.sent(SUBMIT).length === 0 && t.error() !== '' && t.doc.activeElement === t.q('#raName'));
  type(t, '#raName', ' Sam ');
  t.q('[data-ra-send]').click();
  t.q('[data-ra-send]').click();
  await flush();
  check('two presses, one send', t.s.sent(SUBMIT).length === 1, t.s.sent(SUBMIT));
  check('what was sent', JSON.stringify(t.s.sent(SUBMIT)[0].body) === JSON.stringify({ name: 'Sam', note: 'Hello' }));
  check('S4', t.step() === 'sent' && focusedOnHeading(t));
  check('S4 words', t.q('[data-ra-step="sent"]').textContent.indexOf('Watch your email for the Plex invite.') !== -1);
});

await run('the form: what the server can say', async (open) => {
  const cases = [
    [{ status: 400, body: { detail: 'Your Plex check timed out. Start again.' } }, 'intro', 'Your Plex check timed out. Start again.'],
    [{ status: 503, body: { detail: 'We\'re not taking new requests right now. Try again later.' } }, 'form', 'We\'re not taking new requests right now. Try again later.'],
    [{ status: 422, body: { detail: 'Enter your name (up to 80 characters).' } }, 'form', 'Enter your name (up to 80 characters).'],
    [{ status: 422, body: { detail: [{ msg: 'too long' }] } }, 'form', 'Check your name and your answer, then try again.'],
    [{ status: 429, body: { detail: 'Rate limit exceeded' } }, 'form', 'Too many tries. Wait a few minutes and try again.'],
    [{ body: { state: 'approved', sent: false } }, 'status', '']
  ];
  for (const [reply, where, words] of cases) {
    const t = await toForm(open, { [SUBMIT]: [reply] });
    type(t, '#raName', 'Sam');
    type(t, '#raNote', 'Hi');
    await t.click('[data-ra-send]');
    check(`${JSON.stringify(reply).slice(0, 60)}: ${where}`, t.step() === where && t.error() === words, [t.step(), t.error()]);
    check('the button works again', t.q('[data-ra-send]').disabled === false);
  }
});

await run('each status', async (open) => {
  const cases = [
    [{ state: 'pending', submitted_at: '2026-10-09T12:00:00.000Z' }, /^Your request is waiting for review\. Sent .*2026.*\.$/],
    [{ state: 'approved' }, /^You’re approved\. Accept the Plex invite from your email or a Plex app, then sign in here\.$/],
    [{ state: 'invited' }, /^You’re approved\. Accept the Plex invite from your email or a Plex app, then sign in here\.$/],
    [{ state: 'denied', can_ask_after: '2026-11-08T12:00:00.000Z' }, /^This request wasn’t approved\. You can ask again after .*2026.*\.$/],
    [{ state: 'blocked' }, /^This Plex account can’t request access\.$/],
    [{ state: 'member' }, /^You already have access\.$/]
  ];
  for (const [answer, words] of cases) {
    const t = await toWaiting(open, { answers: { [IDENTIFY]: [{ body: Object.assign({ username: 'x', avatar_url: '' }, answer) }] } });
    await t.message(t.popups[0], { type: 'plex-access-complete' });
    const said = t.q('[data-ra-status]').textContent;
    check(`${answer.state}: S5`, t.step() === 'status' && focusedOnHeading(t));
    check(`${answer.state}: says so`, words.test(said), said);
    const button = t.q('[data-ra-step="status"] [data-ra-back]');
    check(`${answer.state}: its button`, button.textContent.trim() === (answer.state === 'member' ? 'Sign in' : 'Back to sign in'));
    if (answer.state === 'member') {
      await t.click(button);
      check('member: to S0, on the first sign-in control', t.step() === 'signin' && t.doc.activeElement === t.q('#username'));
    }
  }
});

await run('phone: away to Plex and back', async (open) => {
  const t = await open({ phone: true, width: 390, answers: { [PIN]: [PIN_OK] } });
  await t.click('#requestAccessLink');
  await t.click('[data-ra-plex]');
  check('no popup', t.opened.length === 0);
  check('the PIN is kept for the way back', t.w.sessionStorage.getItem('access_pin_id') === '4242');
  check('off to Plex', JSON.stringify(t.assigned) === JSON.stringify([AUTH_URL]), t.assigned);
});

await run('phone: back from Plex', async (open) => {
  const t = await open({ url: 'https://ws.test/login?access_request=complete', storedPin: '4242',
                         answers: { [IDENTIFY]: [{ body: { state: 'pending', username: 'x', avatar_url: '', submitted_at: '2026-10-09T12:00:00.000Z' } }] } });
  check('identify with the kept PIN', t.s.sent(IDENTIFY).length === 1 && t.s.sent(IDENTIFY)[0].body.pin_id === 4242);
  check('the query is gone and the step has its hash', t.w.location.search === '' && t.w.location.hash === '#request-access');
  check('the PIN is forgotten', t.w.sessionStorage.getItem('access_pin_id') === null);
  check('S5', t.step() === 'status');
});

await run('phone: back without the PIN', async (open) => {
  const t = await open({ url: 'https://ws.test/login?access_request=complete' });
  check('no identify', t.s.sent(IDENTIFY).length === 0);
  check('S1 says start again', t.step() === 'intro' && t.error() === 'That Plex sign-in expired. Start again.', t.error());
});

await run('text stays text', async (open) => {
  const evil = '<img src=x onerror="window.pwned=1">';
  const t = await toWaiting(open, { answers: { [IDENTIFY]: [{ body: { state: 'new', username: evil, avatar_url: '' } }] } });
  await t.message(t.popups[0], { type: 'plex-access-complete' });
  check('shown as text', t.q('[data-ra-username]').textContent === evil && t.q('[data-ra-username]').children.length === 0);
  check('no avatar without a URL', t.q('[data-ra-avatar]').hidden === true);
});

console.log(`${total - failed}/${total} login request cases pass`);
if (failed) process.exit(1);
```

- [ ] **Step 2: Run it and see it fail**

Run: `node app/tests/js/login_request.mjs`
Expected: it throws reading `js/login-request.js` (ENOENT).

- [ ] **Step 3: The markup**

In `app/static/login.html`, between `</form>` and the `#loginLoadHint` paragraph (the hint stays a later sibling of the form):

```html
<!-- Request access (login-request.js; spec 2026-10-10-request-access-design.md,
     section 9). The link shows only while the site takes requests
     (auth_methods.request_access). Each step below is shown one at a time,
     and what Plex or the person typed is set as text, never as markup. -->
<p id="requestAccessLinkRow" class="w-full text-center mt-6" hidden>
<a id="requestAccessLink" href="#request-access" class="text-frosted-blue text-sm font-medium underline underline-offset-4 decoration-frosted-blue/40 hover:decoration-frosted-blue rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">New here? Request access</a>
</p>
<div id="requestAccess" class="w-full" hidden>
<p id="raLive" class="sr-only" aria-live="polite"></p>
<div data-ra-step="intro" hidden>
<h2 data-ra-heading tabindex="-1" class="text-frosted-blue text-xl font-bold text-center focus:outline-none">Request access</h2>
<p class="mt-3 text-frosted-blue text-sm text-center">Sign in to Plex so we know who you are.</p>
<p class="mt-1 text-frosted-blue/80 text-sm text-center">We only read your Plex username, email and picture.</p>
<button type="button" data-ra-plex class="mt-6 w-full bg-primary hover:bg-primary/90 text-bright font-bold py-3.5 rounded-lg transition-all shadow-lg shadow-primary/20 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background-dark flex items-center justify-center gap-1.5"><span class="text-sm font-medium">Continue with</span>
<!-- the Plex wordmark SVG from #authentikLoginBtn here, copied as is (aria-hidden); the line breaks keep the name "Continue with Plex" -->
<span class="sr-only">Plex</span>
</button>
<button type="button" data-ra-back class="mt-3 w-full text-frosted-blue text-sm font-medium py-2.5 rounded-lg hover:bg-frosted-blue/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">Back to sign in</button>
</div>
<div data-ra-step="waiting" hidden>
<h2 data-ra-heading tabindex="-1" class="text-frosted-blue text-xl font-bold text-center focus:outline-none">Waiting for Plex…</h2>
<p class="mt-3 text-frosted-blue text-sm text-center">Finish signing in to Plex in the window that opened.</p>
<button type="button" data-ra-reopen class="mt-6 w-full bg-primary hover:bg-primary/90 text-bright font-bold py-3.5 rounded-lg transition-all shadow-lg shadow-primary/20 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background-dark">Reopen Plex sign-in</button>
<button type="button" data-ra-cancel class="mt-3 w-full text-frosted-blue text-sm font-medium py-2.5 rounded-lg hover:bg-frosted-blue/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">Cancel</button>
</div>
<form data-ra-step="form" novalidate hidden>
<h2 data-ra-heading tabindex="-1" class="text-frosted-blue text-xl font-bold text-center focus:outline-none">Request access</h2>
<div class="mt-4 flex items-center justify-center gap-3 min-w-0">
<img data-ra-avatar alt="" class="h-10 w-10 shrink-0 rounded-full object-cover" hidden/>
<p class="text-frosted-blue text-sm min-w-0 break-words">Requesting as <span data-ra-username class="font-semibold"></span></p>
</div>
<div class="mt-5 flex flex-col gap-1.5">
<label for="raName" class="text-frosted-blue text-sm font-medium px-1">Your name</label>
<input id="raName" name="name" type="text" autocomplete="name" maxlength="80" required class="w-full bg-frosted-blue/5 border border-frosted-blue/10 rounded-lg py-3 px-4 text-frosted-blue focus:outline-none focus:ring-2 focus:ring-focus focus:border-transparent transition-all"/>
</div>
<div class="mt-4 flex flex-col gap-1.5">
<label for="raNote" class="text-frosted-blue text-sm font-medium px-1">Who are you and how do you know us?</label>
<textarea id="raNote" name="note" rows="4" maxlength="1000" required aria-describedby="raCount" class="w-full bg-frosted-blue/5 border border-frosted-blue/10 rounded-lg py-3 px-4 text-frosted-blue resize-y focus:outline-none focus:ring-2 focus:ring-focus focus:border-transparent transition-all"></textarea>
<p id="raCount" class="text-frosted-blue/80 text-label text-right px-1">0/1000</p>
</div>
<button type="submit" data-ra-send class="mt-5 w-full bg-primary hover:bg-primary/90 text-bright font-bold py-3.5 rounded-lg transition-all shadow-lg shadow-primary/20 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background-dark disabled:opacity-60">Send request</button>
<button type="button" data-ra-back class="mt-3 w-full text-frosted-blue text-sm font-medium py-2.5 rounded-lg hover:bg-frosted-blue/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">Back to sign in</button>
</form>
<div data-ra-step="sent" hidden>
<h2 data-ra-heading tabindex="-1" class="text-frosted-blue text-xl font-bold text-center focus:outline-none">Request sent</h2>
<p class="mt-3 text-frosted-blue text-sm text-center">Watch your email for the Plex invite.</p>
<button type="button" data-ra-back class="mt-6 w-full bg-primary hover:bg-primary/90 text-bright font-bold py-3.5 rounded-lg transition-all shadow-lg shadow-primary/20 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background-dark">Back to sign in</button>
</div>
<div data-ra-step="status" hidden>
<h2 data-ra-heading tabindex="-1" class="text-frosted-blue text-xl font-bold text-center focus:outline-none">Your request</h2>
<p data-ra-status class="mt-3 text-frosted-blue text-sm text-center"></p>
<button type="button" data-ra-back class="mt-6 w-full bg-primary hover:bg-primary/90 text-bright font-bold py-3.5 rounded-lg transition-all shadow-lg shadow-primary/20 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background-dark">Back to sign in</button>
</div>
</div>
<!-- show() moves this line to just above the current step's first button. -->
<p id="raError" role="alert" class="w-full mt-4 text-status-err-text text-sm font-medium text-center text-balance empty:hidden"></p>
```

Before `<script src="/static/js/login.js?v=1"></script>`:

```html
<script src="/static/js/login-request.js?v=1"></script>
```

In the `<style>` block, extend the text-shadow selector list (`.login-glass-card label, #ssoDivider span, ...`) with `#requestAccess h2, #requestAccess p, #requestAccessLinkRow a, #raError`, and add before `</style>`:

```css
    /* Request access (login-request.js): each step fades in as it is shown
       (display none to block replays the animation). Reduced motion shows it
       at once. The card's height follows its content and does not animate. */
    #requestAccess [data-ra-step] { animation: ra-step-in 160ms ease-out both; }
    @keyframes ra-step-in { from { opacity: 0; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) {
      #requestAccess [data-ra-step] { animation: none; }
    }
```

- [ ] **Step 4: The script**

Create `app/static/js/login-request.js`:

```js
/**
 * WebServarr: request access, inside the sign-in card (/login)
 *
 * A visitor asks for access from the sign-in card
 * (docs/superpowers/specs/2026-10-10-request-access-design.md, section 9).
 * They prove their Plex account in the Plex window, fill in a short form,
 * and the admin answers in Settings. Nothing here signs anyone in: the
 * server makes no session for this flow.
 *
 * The steps are static blocks in login.html, hidden until shown, so nothing
 * is built from markup strings; what Plex or the person typed is set as
 * text. Loaded before login.js, which calls WSRequestAccess.apply(theme)
 * whenever it applies the sign-in methods. A file: the CSP is script-src 'self'.
 */
var WSRequestAccess = (function () {
  'use strict';

  var API = '/api/access-requests';
  var HASH = '#request-access';
  var PIN_KEY = 'access_pin_id';
  var NOTE_MAX = 1000;
  var NOT_YET = 'PIN not yet authorized. Try again.';
  var RETRY_MS = 2000;
  var RETRIES = 5;
  var POLL_MS = 1000;
  var MSG = {
    closedEarly: 'Plex sign-in was closed before it finished.',
    blocked: 'Your browser blocked the Plex window. Allow pop-ups, then press Reopen Plex sign-in.',
    plexDown: 'Plex isn’t answering right now. Try again in a minute.',
    offline: 'That didn’t go through. Check your connection and try again.',
    tooMany: 'Too many tries. Wait a few minutes and try again.',
    expired: 'That Plex sign-in expired. Start again.',
    closed: 'Access requests are closed.',
    form: 'Check your name and your answer, then try again.'
  };
  var APPROVED = 'You’re approved. Accept the Plex invite from your email or a Plex app, then sign in here.';
  var STATUS = {
    pending: function (d) { return 'Your request is waiting for review. Sent ' + day(d.submitted_at) + '.'; },
    approved: function () { return APPROVED; },
    invited: function () { return APPROVED; },
    denied: function (d) { return 'This request wasn’t approved. You can ask again after ' + day(d.can_ask_after) + '.'; },
    blocked: function () { return 'This Plex account can’t request access.'; },
    member: function () { return 'You already have access.'; }
  };

  var on = false;          // the site takes requests (auth_methods.request_access)
  var wired = false;
  var resumed = false;     // the phone's way back has been looked at
  var pushed = false;      // this page pushed the #request-access entry
  var current = 'signin';
  var popup = null;
  var pollTimer = null;
  var pinId = null;
  var authUrl = '';
  var busy = false;

  function $(id) { return document.getElementById(id); }
  function step(name) { return document.querySelector('[data-ra-step="' + name + '"]'); }

  function day(iso) {
    var d = new Date(iso || '');
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function setError(text) { $('raError').textContent = text || ''; }

  // Shown means no ancestor hides it (login.js hides the password fields by
  // style when that sign-in is off).
  function shown(n) {
    for (; n && n !== document.body; n = n.parentElement) {
      if (n.hidden || n.classList.contains('hidden') || n.style.display === 'none') return false;
    }
    return !!n;
  }

  function firstSignIn() {
    var c = document.querySelectorAll('#loginForm input, #loginForm button');
    for (var i = 0; i < c.length; i++) if (shown(c[i])) return c[i];
    return null;
  }

  // One step on screen. 'signin' is today's card (S0).
  function show(name, firstControl) {
    current = name;
    var inFlow = name !== 'signin';
    $('loginForm').hidden = inFlow;
    $('requestAccessLinkRow').hidden = inFlow || !on;
    $('requestAccess').hidden = !inFlow;
    var steps = document.querySelectorAll('#requestAccess [data-ra-step]');
    for (var i = 0; i < steps.length; i++) steps[i].hidden = steps[i].getAttribute('data-ra-step') !== name;
    // The error line sits just above this step's buttons (Jordan, mockup 2026-10-10).
    var first = inFlow ? step(name).querySelector('button') : null;
    if (first) first.parentNode.insertBefore($('raError'), first);
    setError('');
    if (!inFlow) {
      var target = firstControl ? firstSignIn() : $('requestAccessLink');
      if (target && shown(target)) target.focus();
      return;
    }
    var h = step(name).querySelector('[data-ra-heading]');
    $('raLive').textContent = h ? h.textContent : '';
    if (h) h.focus();
  }

  function enter(name) {
    if (location.hash !== HASH) {
      history.pushState(null, '', location.pathname + location.search + HASH);
      pushed = true;
    }
    show(name);
  }

  function leaveHash() {
    if (location.hash !== HASH) return;
    if (pushed) { pushed = false; history.back(); return; }
    history.replaceState(null, '', location.pathname + location.search);
  }

  function backToSignIn(firstControl) {
    stopPopup(true);
    pinId = null;
    show('signin', firstControl);
    leaveHash();
  }

  function onPop() {
    if (location.hash === HASH) { if (on && current === 'signin') show('intro'); return; }
    pushed = false;
    if (current !== 'signin') { stopPopup(true); pinId = null; show('signin'); }
  }

  // ---- The server ----

  function send(url, body) {
    var init = { method: 'POST', credentials: 'same-origin', headers: {} };
    if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(url, init).then(function (r) {
      return r.text().then(function (text) {
        var d = null;
        try { d = text ? JSON.parse(text) : null; } catch (e) { d = null; }
        d = d && typeof d === 'object' ? d : {};
        return { ok: r.ok, status: r.status, data: d, detail: typeof d.detail === 'string' ? d.detail : '' };
      });
    }, function () { return { ok: false, status: 0, data: {}, detail: '' }; });
  }

  // An answer the card can't move on with: say why, on the same step.
  function fail(res) {
    if (res.status === 403) { closeFlow(); return; }
    setError(res.status === 0 ? MSG.offline
      : res.status === 429 ? MSG.tooMany
      : res.detail ? res.detail
      : res.status === 422 ? MSG.form : MSG.plexDown);
  }

  // The site stopped taking requests while this card was open.
  function closeFlow() {
    on = false;
    backToSignIn(false);
    setError(MSG.closed);
  }

  // ---- Plex ----

  function stopPopup(closeIt) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (closeIt && popup && !popup.closed) popup.close();
    popup = null;
  }

  function watch(win) {
    stopPopup(false);
    popup = win;
    pollTimer = setInterval(function () {
      if (popup && popup.closed) { stopPopup(false); identify('closed', 0); }
    }, POLL_MS);
  }

  function onMessage(e) {
    // Only the popup this page opened, back on this origin (plex-callback.js
    // posts to it), and only the request flow's message.
    if (!popup || e.origin !== window.location.origin || e.source !== popup) return;
    if (!e.data || e.data.type !== 'plex-access-complete') return;
    stopPopup(true);
    identify('message', 0);
  }

  function isPhone() { return /Mobi|Android/i.test(navigator.userAgent) || window.innerWidth < 768; }

  function startPlex() {
    if (busy) return;
    setError('');
    var phone = isPhone();
    // Opened inside the click, before any wait, so the browser allows it.
    var win = phone ? null : window.open('', 'PlexAccess', 'width=800,height=600');
    busy = true;
    send(API + '/pin').then(function (res) {
      busy = false;
      if (!res.ok || !res.data.pin_id || !res.data.auth_url) {
        if (win && !win.closed) win.close();
        fail(res);
        return;
      }
      pinId = res.data.pin_id;
      authUrl = res.data.auth_url;
      if (phone) {
        try { sessionStorage.setItem(PIN_KEY, String(pinId)); } catch (e) { /* the way back then says start again */ }
        location.assign(authUrl);
        return;
      }
      show('waiting');
      if (!win || win.closed) { setError(MSG.blocked); return; }
      win.location.href = authUrl;
      watch(win);
    });
  }

  function reopen() {
    if (!authUrl || pinId == null) { show('intro'); setError(MSG.expired); return; }
    setError('');
    var win = window.open(authUrl, 'PlexAccess', 'width=800,height=600');
    if (!win) { setError(MSG.blocked); return; }
    watch(win);
  }

  function identify(why, tries) {
    if (pinId == null) { show('intro'); setError(MSG.expired); return; }
    var id = pinId;
    send(API + '/identify', { pin_id: id }).then(function (res) {
      if (id !== pinId) return;              // a newer start, or the card was left
      if (res.status === 409) return;         // another call is finishing this PIN; its answer counts
      if (res.ok) { pinId = null; land(res.data); return; }
      if (res.status === 400 && res.detail === NOT_YET) {
        if (why === 'closed') { pinId = null; show('intro'); setError(MSG.closedEarly); return; }
        if (tries < RETRIES) { setTimeout(function () { identify(why, tries + 1); }, RETRY_MS); return; }
        pinId = null; show('intro'); setError(MSG.expired); return;
      }
      if (res.status === 400) { pinId = null; show('intro'); setError(res.detail || MSG.expired); return; }
      fail(res);
    });
  }

  // ---- After identify ----

  function land(d) {
    if (d.state === 'new') { fillForm(d); show('form'); return; }
    showStatus(d);
  }

  function fillForm(d) {
    var box = step('form');
    box.querySelector('[data-ra-username]').textContent = typeof d.username === 'string' ? d.username : '';
    var img = box.querySelector('[data-ra-avatar]');
    if (typeof d.avatar_url === 'string' && d.avatar_url) { img.src = d.avatar_url; img.hidden = false; }
    else { img.removeAttribute('src'); img.hidden = true; }
    $('raName').value = '';
    $('raNote').value = '';
    count();
  }

  function showStatus(d) {
    var box = step('status');
    var say = STATUS[d.state];
    box.setAttribute('data-state', say ? d.state : '');
    box.querySelector('[data-ra-status]').textContent = say ? say(d) : MSG.expired;
    box.querySelector('[data-ra-back]').textContent = d.state === 'member' ? 'Sign in' : 'Back to sign in';
    show('status');
  }

  function count() { $('raCount').textContent = $('raNote').value.length + '/' + NOTE_MAX; }

  function submit(e) {
    e.preventDefault();
    if (busy) return;
    var name = $('raName').value.trim();
    var note = $('raNote').value.trim();
    if (!name || !note) { setError(MSG.form); (name ? $('raNote') : $('raName')).focus(); return; }
    var button = step('form').querySelector('[data-ra-send]');
    busy = true;
    button.disabled = true;
    send(API, { name: name, note: note }).then(function (res) {
      busy = false;
      button.disabled = false;
      if (res.ok && res.data.sent) { show('sent'); return; }
      if (res.ok) { showStatus(res.data); return; }
      if (res.status === 400) { show('intro'); setError(res.detail || MSG.expired); return; }
      fail(res);
    });
  }

  // ---- Wiring ----

  function wire() {
    wired = true;
    $('requestAccessLink').addEventListener('click', function (e) { e.preventDefault(); enter('intro'); });
    document.querySelector('[data-ra-plex]').addEventListener('click', startPlex);
    document.querySelector('[data-ra-reopen]').addEventListener('click', reopen);
    document.querySelector('[data-ra-cancel]').addEventListener('click', function () {
      stopPopup(true);
      pinId = null;
      show('intro');
    });
    var backs = document.querySelectorAll('[data-ra-back]');
    for (var i = 0; i < backs.length; i++) {
      backs[i].addEventListener('click', function () {
        backToSignIn(current === 'status' && step('status').getAttribute('data-state') === 'member');
      });
    }
    step('form').addEventListener('submit', submit);
    $('raNote').addEventListener('input', count);
    window.addEventListener('message', onMessage);
    window.addEventListener('popstate', onPop);
  }

  // A phone back from Plex: /login?access_request=complete. Ignored while
  // the site takes no requests.
  function resume() {
    resumed = true;
    var params = new URLSearchParams(location.search);
    if (params.get('access_request') !== 'complete') {
      if (location.hash === HASH) show('intro');
      return;
    }
    var stored = null;
    try { stored = sessionStorage.getItem(PIN_KEY); sessionStorage.removeItem(PIN_KEY); } catch (e) { stored = null; }
    history.replaceState(null, '', location.pathname);
    enter('waiting');
    if (!stored || !/^[0-9]+$/.test(stored)) { show('intro'); setError(MSG.expired); return; }
    pinId = parseInt(stored, 10);
    identify('return', 0);
  }

  function apply(theme) {
    on = !!(theme && theme.auth_methods && theme.auth_methods.request_access);
    var row = $('requestAccessLinkRow');
    if (!row || !$('requestAccess')) return;
    if (current === 'signin') row.hidden = !on;
    if (!on) return;
    if (!wired) wire();
    if (!resumed) resume();
  }

  return { apply: apply };
})();
```

In `app/static/js/login.js`, at the end of `applyLoginBranding` (after the simple-auth block, before its closing brace):

```js
    // Request access (login-request.js, loaded just before this file): its
    // link, and the phone's way back from Plex, follow the same branding.
    if (window.WSRequestAccess) window.WSRequestAccess.apply(theme);
```

- [ ] **Step 5: Wire the test into the runs and rebuild the CSS**

Add `node app/tests/js/login_request.mjs` to the end of `package.json` `test:js` and of the CI `js-checks` list. Then:
Run: `npm run build:css`
Expected: `app.css` rebuilt (new classes: `empty:hidden`, `decoration-*`, `resize-y`, `disabled:opacity-60` and the rest).

- [ ] **Step 6: Run the front-end tests**

Run: `node app/tests/js/login_request.mjs`
Expected: `N/N login request cases pass`.
Run: `npm run test:js`
Expected: every file passes (`login_status.mjs` included: its page is the same `login.html`).

- [ ] **Step 7: Commit**

```bash
git add app/static/login.html app/static/js/login-request.js app/static/js/login.js app/static/css/app.css package.json .github/workflows/docker-publish.yml app/tests/js/login_request.mjs
git commit -m "feat(access): request access from inside the sign-in card"
```

- [ ] **Step 8: Deploy to dev and check**

Deploy sequence (no restart: static files only). Run on dev, each its own command: `app.tests.test_pages`, `app.tests.test_soft_nav`, `app.tests.test_brand_name`, `app.tests.test_motion`, `app.tests.test_audit_mechanical`, `app.tests.test_css_build`, `app.tests.test_icon_font`, then the full suite. Expected: all green. If a static test pins something this task changed (for example the login page's script tags or a count of animations), update that test's expectation in the same spirit and say why in the commit message of a follow-up commit. CI green.

### Task 10: Settings > Access requests (after Jordan approves Task 3)

**Do not start until Jordan has approved the Task 3 mockup.** As in Task 9, the approved mockup decides the look; the hooks, words and behaviour here are fixed.

**Files:**
- Modify: `app/static/settings.html` (tab link with its badge, panel with its skeleton, the module's template script)
- Modify: `app/static/js/settings/first-paint.js` (`TABS`)
- Modify: `app/static/js/settings/kit.js` (`TABS`, `TITLES`, `setCount`, the count read on init)
- Modify: `app/static/css/theme.css` (the tab's two selectors)
- Create: `app/static/js/settings/access-requests.js`
- Modify: `app/tests/test_settings_static.py` (`TABS`, `MODULES`, `Skeletons.MODULE`)
- Modify: `app/static/css/app.css` (rebuilt), `package.json`, `.github/workflows/docker-publish.yml`
- Test: `app/tests/js/settings_access.mjs`

**Interfaces:**
- Consumes: the five admin routes (Task 8); `access_requests.enabled` and `access_requests.default_libraries` through the kit and `PUT /api/admin/settings/bulk` (Task 4); `WSSettings.card`, `api.toggle`, `api.track`, `api.get`, `api.set`, `api.saved`, `WSSettings.confirm`, `WSSettings.toast`, `WSSettings.leave`.
- Produces: `WSSettings.setCount(tabId, n)` (the tab's badge; also called by the kit on init with `/api/admin/access-requests/count`).

- [ ] **Step 1: Write the failing test**

Create `app/tests/js/settings_access.mjs`:

```js
// Settings > Access requests (app/static/js/settings/access-requests.js),
// run for real in happy-dom over Settings' own markup and the real kit, with
// a scripted server. Covers: the tab's count badge and its accessible name
// on any tab; the four cards; the switch's Plex note; the default libraries
// as settings (staged, saved through the bulk save); each waiting request
// shown as text (line breaks kept, markup not run); Approve (the dialog
// with the default libraries ticked, one dialog for two presses, at least
// one library, the share's outcome, Plex not listing libraries means no
// dialog); the failed share's reason and the copy button; Deny and Block;
// Unblock; a failed load and Try again.
// Run: node app/tests/js/settings_access.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const SETTINGS_HTML = readFileSync(join(STATIC, 'settings.html'), 'utf8');
const SRC = {};
for (const f of ['ui.js', 'settings/kit.js', 'settings/signin-rule.js', 'settings/access-requests.js']) {
  SRC[f] = readFileSync(join(STATIC, 'js', f), 'utf8');
}

let failed = 0;
let total = 0;
let current = '';
function check(what, ok, info) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${current}: ${what}` + (info === undefined ? '' : ` (${JSON.stringify(info)})`));
  }
}
const flush = async () => { for (let i = 0; i < 14; i++) await new Promise((r) => setImmediate(r)); };
const MASK = '••••••••';
const LIBS = [{ key: '1', title: 'Movies', type: 'movie' }, { key: '2', title: 'TV', type: 'show' }];
const NOTE = 'Line one\nLine two <b>not bold</b>';

function request(id, extra = {}) {
  return Object.assign({ id, plex_username: 'user' + id, plex_email: `u${id}@example.com`, avatar_url: '',
    name: 'Name ' + id, note: NOTE, status: 'pending', share_state: null, share_error: null, library_keys: [],
    created_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(), decided_at: null, can_ask_after: null }, extra);
}

function makeServer(over = {}) {
  const s = Object.assign({
    calls: [], pending: [request(1), request(2)], decided: [], blocked: [request(9, { status: 'blocked', decided_at: new Date().toISOString() })],
    libsStatus: 200, listStatus: 200, approveReply: null,
    values: { 'access_requests.enabled': 'false', 'access_requests.default_libraries': '["1"]',
              'integration.plex.url': 'http://192.168.1.2:32400', 'integration.plex.token': MASK }
  }, over);
  s.fetch = (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    s.calls.push({ method, url: String(url), body });
    const u = new URL(String(url), 'https://ws.test');
    const reply = (status, b) => Promise.resolve({ ok: status >= 200 && status < 300, status,
      json: () => Promise.resolve(b), text: () => Promise.resolve(b === undefined ? '' : JSON.stringify(b)) });
    if (u.pathname === '/api/admin/settings' && u.search.indexOf('view=registry') !== -1) {
      const meta = {};
      for (const k of Object.keys(s.values)) meta[k] = { type: k.endsWith('enabled') ? 'bool' : 'text', default: '', secret: k.endsWith('token'), max_length: 2000 };
      return reply(200, { values: s.values, meta, mask: MASK, page_order: [], page_addresses: {}, address_credentials: {} });
    }
    if (u.pathname === '/api/admin/settings/bulk' && method === 'PUT') {
      for (const it of body.settings) s.values[it.key] = it.value;
      return reply(200, { values: Object.fromEntries(body.settings.map((it) => [it.key, it.value])) });
    }
    const base = '/api/admin/access-requests';
    if (u.pathname === base + '/count') return reply(200, { pending: s.pending.length });
    if (u.pathname === base + '/libraries') return s.libsStatus === 200 ? reply(200, { libraries: LIBS }) : reply(s.libsStatus, { detail: 'Plex didn\'t answer' });
    if (u.pathname === base && method === 'GET') {
      return s.listStatus === 200 ? reply(200, { pending: s.pending, decided: s.decided, blocked: s.blocked }) : reply(s.listStatus, { detail: 'down' });
    }
    const m = u.pathname.match(/^\/api\/admin\/access-requests\/(\d+)\/(approve|deny|unblock)$/);
    if (m && method === 'POST') {
      const id = Number(m[1]);
      if (m[2] === 'unblock') { s.blocked = s.blocked.filter((r) => r.id !== id); return reply(200, { ok: true }); }
      const row = s.pending.find((r) => r.id === id);
      if (!row) return reply(409, { detail: 'That request was already answered.' });
      s.pending = s.pending.filter((r) => r.id !== id);
      if (m[2] === 'deny') {
        const done = Object.assign({}, row, { status: body.block ? 'blocked' : 'denied', decided_at: new Date().toISOString(),
          can_ask_after: body.block ? null : new Date(Date.now() + 30 * 86400000).toISOString() });
        (body.block ? s.blocked : s.decided).unshift(done);
        return reply(200, done);
      }
      const done = Object.assign({}, row, { status: 'approved', decided_at: new Date().toISOString(), library_keys: body.library_keys },
        s.approveReply || { share_state: 'shared', share_error: null });
      s.decided.unshift(done);
      return reply(200, done);
    }
    return reply(404, {});
  };
  return s;
}

async function visit(o = {}) {
  const url = o.url || 'https://ws.test/settings#access-requests';
  const win = new Window({ url });
  const doc = win.document;
  doc.body.innerHTML = SETTINGS_HTML.match(/<body[^>]*>([\s\S]*)<\/body>/)[1];
  const ctl = new win.AbortController();
  const server = o.server || makeServer();
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  const clipboard = [];
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText(text) { clipboard.push(text); return Promise.resolve(); } }, configurable: true });
  set('window', win);
  set('document', doc);
  set('location', win.location);
  set('localStorage', win.localStorage);
  set('fetch', server.fetch);
  if (!process.env.DEBUG_TEST) set('console', { error() {}, warn() {}, log() {}, info() {}, debug() {} });
  set('ResizeObserver', class { observe() {} disconnect() {} });
  set('CustomEvent', win.CustomEvent);
  set('Event', win.Event);
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const run = (name) => new Function('window', 'document', 'localStorage', 'location', 'WSUI', 'WSSettings', 'fetch', SRC[name])(
    win, doc, win.localStorage, win.location, win.WSUI, win.WSSettings, globalThis.fetch);
  run('ui.js');
  run('settings/kit.js');
  run('settings/signin-rule.js');
  run('settings/access-requests.js');
  const toasts = [];
  const realToast = win.WSUI.toast;
  win.WSUI.toast = (m, kind) => { toasts.push([m, kind]); return realToast(m, kind); };
  const ctx = { signal: ctl.signal, url: new URL(url), setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
                clearTimeout: (id) => clearTimeout(id), poll() { return () => {}; }, beforeLeave() {}, onNavigate() {} };
  const t = {
    win, doc, server, toasts, clipboard, ctl,
    q: (sel) => doc.querySelector(sel),
    qa: (sel) => Array.from(doc.querySelectorAll(sel)),
    release() { for (const k of Object.keys(saved)) { if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k]; } },
    async open() { win.WSSettings.init(ctx); await new Promise((r) => setTimeout(r, 20)); await flush(); return t; },
    async press(sel) { (typeof sel === 'string' ? doc.querySelector(sel) : sel).click(); await new Promise((r) => setTimeout(r, 10)); await flush(); },
    // The open dialog: one that is closing fades out for a moment first.
    dialog: () => Array.from(doc.querySelectorAll('.ws-dialog:not(.is-closing) .ws-dialog-box')).pop() || null,
    button(box, words) { return Array.from(box.querySelectorAll('button')).find((b) => b.textContent.trim() === words); },
    calls: (method, path) => server.calls.filter((c) => c.method === method && c.url.indexOf(path) === 0)
  };
  return t;
}

async function run(name, fn) {
  current = name;
  const made = [];
  try { await fn(async (o) => { const t = await visit(o); made.push(t); return t.open(); }); }
  catch (e) { failed += 1; total += 1; console.error(`FAIL ${name}: threw ${e && e.stack || e}`); }
  finally { while (made.length) { const t = made.pop(); t.ctl.abort(); t.release(); } }
}

const panel = '[data-settings-panel="access-requests"]';
const tab = '#tab-access-requests';

await run('the badge, on any tab', async (open) => {
  const t = await open({ url: 'https://ws.test/settings#general' });
  const badge = t.q(`${tab} [data-tab-count]`);
  check('shows the count', !badge.hidden && badge.textContent === '2', badge.textContent);
  check('named for screen readers', t.q(tab).getAttribute('aria-label') === 'Access requests 2 waiting');
  check('the badge itself is not read twice', badge.getAttribute('aria-hidden') === 'true');
  const none = await open({ url: 'https://ws.test/settings#general', server: makeServer({ pending: [] }) });
  check('hidden at 0, no extra name', none.q(`${tab} [data-tab-count]`).hidden && !none.q(tab).hasAttribute('aria-label'));
});

await run('the panel', async (open) => {
  const t = await open();
  const heads = t.qa(`${panel} h2`).map((h) => h.textContent);
  check('four cards', JSON.stringify(heads) === JSON.stringify(['Sign-in page', 'Default libraries', 'Waiting', 'Decided']), heads);
  check('the switch', t.q(`${panel} [role="switch"]`) !== null);
  check('Plex is connected: no note', t.q('[data-ar-needs-plex]').hidden === true);
  const cards = t.qa('[data-ar-request]');
  check('pending in order', cards.map((c) => c.getAttribute('data-ar-request')).join() === '1,2');
  const note = cards[0].querySelector('[data-ar-note]');
  check('the note as text with its line breaks', note.textContent === NOTE && note.querySelector('b') === null);
  check('who and when', cards[0].textContent.indexOf('user1') !== -1 && cards[0].textContent.indexOf('u1@example.com') !== -1 &&
    cards[0].textContent.indexOf('Name 1') !== -1 && /Sent 3 hours ago/.test(cards[0].textContent), cards[0].textContent);
  check('named buttons', cards[0].querySelector('[data-ar-approve]').getAttribute('aria-label') === 'Approve user1');
  check('the blocked account with Unblock', t.q('[data-ar-decided-row="9"] [data-ar-unblock]') !== null);
});

await run('Plex not connected', async (open) => {
  const s = makeServer();
  s.values['integration.plex.token'] = '';
  const t = await open({ server: s });
  check('the switch says it needs Plex', t.q('[data-ar-needs-plex]').hidden === false);
});

await run('default libraries are a setting', async (open) => {
  const t = await open();
  const boxes = t.qa('[data-ar-defaults] input[type="checkbox"]');
  check('one per library, the saved one ticked', boxes.map((b) => b.value + ':' + b.checked).join() === '1:true,2:false');
  boxes[1].click();
  await flush();
  check('staged, the save bar up', t.q('#settingsSaveBar').hidden === false);
  const save = Array.from(t.doc.querySelectorAll('#settingsSaveBar button')).find((b) => /Save/.test(b.textContent));
  await t.press(save);
  const put = t.calls('PUT', '/api/admin/settings/bulk')[0];
  check('saved as a list', put && JSON.stringify(put.body.settings) === JSON.stringify([{ key: 'access_requests.default_libraries', value: '["1","2"]' }]), put && put.body);
});

await run('approve', async (open) => {
  const t = await open();
  const button = t.q('[data-ar-request="1"] [data-ar-approve]');
  await t.press(button);
  await t.press(button);
  check('one dialog for two presses', t.qa('.ws-dialog:not(.is-closing)').length === 1);
  const box = t.dialog();
  check('titled for the person', box.textContent.indexOf('Approve user1?') !== -1);
  const ticks = Array.from(box.querySelectorAll('input[type="checkbox"]'));
  check('the default library ticked', ticks.map((b) => b.value + ':' + b.checked).join() === '1:true,2:false');
  ticks[1].click();
  await t.press(t.button(box, 'Share and approve'));
  const post = t.calls('POST', '/api/admin/access-requests/1/approve');
  check('one approve with the ticked libraries', post.length === 1 && JSON.stringify(post[0].body) === JSON.stringify({ library_keys: ['1', '2'] }));
  check('said so', t.toasts.some(([m, k]) => m === 'Approved. Plex sent them an invite.' && k === 'ok'), t.toasts);
  check('moved to Decided', t.q('[data-ar-request="1"]') === null && t.q('[data-ar-decided-row="1"]') !== null);
  check('the badge follows', t.q(`${tab} [data-tab-count]`).textContent === '1');
});

await run('approve needs a library', async (open) => {
  const t = await open();
  await t.press('[data-ar-request="1"] [data-ar-approve]');
  const box = t.dialog();
  box.querySelector('input[type="checkbox"]').click();
  await t.press(t.button(box, 'Share and approve'));
  check('nothing sent', t.calls('POST', '/api/admin/access-requests/1/approve').length === 0);
  check('says why', t.toasts.some(([m]) => m === 'Pick at least one library.'));
  check('still waiting', t.q('[data-ar-request="1"]') !== null);
});

await run('Plex lists no libraries: no dialog', async (open) => {
  const t = await open({ server: makeServer({ libsStatus: 503 }) });
  const before = t.calls('GET', '/api/admin/access-requests/libraries').length;
  await t.press('[data-ar-request="1"] [data-ar-approve]');
  check('no dialog', t.dialog() === null);
  check('says why', t.toasts.some(([m, k]) => k === 'err' && /libraries/.test(m)), t.toasts);
  check('asks Plex again', t.calls('GET', '/api/admin/access-requests/libraries').length === before + 1);
  check('still waiting', t.q('[data-ar-request="1"]') !== null);
});

await run('a share that failed', async (open) => {
  const t = await open({ server: makeServer({ approveReply: { share_state: 'failed', share_error: 'Plex refused the share (HTTP 400)' } }) });
  await t.press('[data-ar-request="1"] [data-ar-approve]');
  await t.press(t.button(t.dialog(), 'Share and approve'));
  check('said so', t.toasts.some(([m, k]) => k === 'err' && /Share it in Plex yourself/.test(m)), t.toasts);
  const row = t.q('[data-ar-decided-row="1"]');
  check('the reason on the row', row.querySelector('[data-ar-share-error]').textContent === 'Plex refused the share (HTTP 400)');
  await t.press(row.querySelector('[data-ar-copy]'));
  check('the username copied', JSON.stringify(t.clipboard) === '["user1"]');
  check('confirmed', t.toasts.some(([m]) => m === 'Copied user1. Share your server with them in Plex.'));
});

await run('deny and block', async (open) => {
  const t = await open();
  await t.press('[data-ar-request="1"] [data-ar-deny]');
  await t.press(t.button(t.dialog(), 'Deny'));
  check('denied', JSON.stringify(t.calls('POST', '/api/admin/access-requests/1/deny')[0].body) === '{"block":false}');
  await t.press('[data-ar-request="2"] [data-ar-deny]');
  const box = t.dialog();
  check('the block choice', box.textContent.indexOf('Block this Plex account for good') !== -1);
  box.querySelector('[data-ar-block]').click();
  await t.press(t.button(box, 'Deny'));
  check('blocked', JSON.stringify(t.calls('POST', '/api/admin/access-requests/2/deny')[0].body) === '{"block":true}');
  check('both answered', t.qa('[data-ar-request]').length === 0);
});

await run('unblock', async (open) => {
  const t = await open();
  await t.press('[data-ar-decided-row="9"] [data-ar-unblock]');
  check('sent', t.calls('POST', '/api/admin/access-requests/9/unblock').length === 1);
  check('gone from the list', t.q('[data-ar-decided-row="9"]') === null);
});

await run('a failed load, then Try again', async (open) => {
  const s = makeServer({ listStatus: 503 });
  const t = await open({ server: s });
  const retry = Array.from(t.doc.querySelectorAll(`${panel} button`)).find((b) => b.textContent === 'Try again');
  check('says so with Try again', !!retry);
  s.listStatus = 200;
  await t.press(retry);
  check('then the list', t.qa('[data-ar-request]').length === 2);
});

console.log(`${total - failed}/${total} settings access cases pass`);
if (failed) process.exit(1);
```

- [ ] **Step 2: Run it and see it fail**

Run: `node app/tests/js/settings_access.mjs`
Expected: it throws reading `settings/access-requests.js` (ENOENT).

- [ ] **Step 3: The frame**

In `app/static/settings.html`:
- In `#settingsTabs`, after the Sign-in tab:

```html
          <a role="tab" id="tab-access-requests" href="#access-requests" data-tab="access-requests" aria-controls="panel-access-requests" aria-selected="false" class="ws-tab">Access requests <span data-tab-count aria-hidden="true" class="inline-flex min-w-5 h-5 px-1.5 items-center justify-center rounded-full bg-primary text-bright text-label font-bold" hidden></span></a>
```

- After the `panel-sign-in` section:

```html
    <section id="panel-access-requests" data-settings-panel="access-requests" role="tabpanel" aria-labelledby="tab-access-requests">
      <div aria-hidden="true" data-skel="access-requests">
        <div class="mb-12 last:mb-0"><div class="mb-5"><h2 class="text-[20px] font-bold tracking-tight text-frosted-blue"><span class="skel-text">Sign-in page</span></h2><p class="text-[15px] text-frosted-blue/70 mt-1 max-w-2xl"><span class="skel-text">Let people who don’t have access yet ask for it from the sign-in card.</span></p></div><div class="space-y-6"><div class="flex items-start justify-between gap-4 max-w-2xl"><div class="min-w-0"><div class="block text-[15px] font-semibold text-frosted-blue"><span class="skel-text">Let people request access from the sign-in page</span></div></div><span class="skel block w-11 h-6 rounded-full shrink-0"></span></div></div></div>
        <div class="mb-12 last:mb-0"><div class="mb-5"><h2 class="text-[20px] font-bold tracking-tight text-frosted-blue"><span class="skel-text">Default libraries</span></h2><p class="text-[15px] text-frosted-blue/70 mt-1 max-w-2xl"><span class="skel-text">Ticked for a new person when you approve them. You can change them for each person.</span></p></div><div class="space-y-6"><div class="space-y-2"><span class="skel skel-line block w-40"></span><span class="skel skel-line block w-32"></span></div></div></div>
        <div class="mb-12 last:mb-0"><div class="mb-5"><h2 class="text-[20px] font-bold tracking-tight text-frosted-blue"><span class="skel-text">Waiting</span></h2><p class="text-[15px] text-frosted-blue/70 mt-1 max-w-2xl"><span class="skel-text">People who asked for access. Approving shares your Plex server with them.</span></p></div><div class="space-y-6"><div class="skel h-40 rounded-2xl"></div></div></div>
        <div class="mb-12 last:mb-0"><div class="mb-5"><h2 class="text-[20px] font-bold tracking-tight text-frosted-blue"><span class="skel-text">Decided</span></h2><p class="text-[15px] text-frosted-blue/70 mt-1 max-w-2xl"><span class="skel-text">Answers from the last 30 days, and the accounts you blocked.</span></p></div><div class="space-y-6"><div class="skel h-16 rounded-2xl"></div></div></div>
      </div>
    </section>
```

- In `<template id="settingsModules">`, after the sign-in line:

```html
  <script data-tab="access-requests" src="/static/js/settings/access-requests.js?v=1" data-ws-page-script></script>
```

In `app/static/js/settings/first-paint.js` and in `kit.js`, put `'access-requests'` after `'sign-in'` in `TABS`. In `kit.js` `TITLES`, add `'access-requests': 'Access requests'`.

In `app/static/css/theme.css`, add `html[data-settings-tab="access-requests"] #tab-access-requests,` to the selected-tab selector list and `html[data-settings-tab="access-requests"] [data-settings-panel="access-requests"],` to the panel selector list (each after its sign-in line).

In `app/tests/test_settings_static.py`, add `"access-requests"` after `"sign-in"` in `TABS`, `"access-requests": "access-requests.js"` to `MODULES` and `"access-requests": "settings/access-requests.js"` to `Skeletons.MODULE`.

- [ ] **Step 4: The kit's count badge**

In `app/static/js/settings/kit.js`, before `var WSSettings = {`:

```js
  // A tab's count of things waiting on the admin (Access requests): a badge on
  // the tab whichever tab is open, and the tab's name says it ("Access
  // requests 3 waiting": it starts with the visible text, so the two match).
  // Hidden at 0.
  function setCount(id, n) {
    var a = document.getElementById('tab-' + id);
    var badge = a && a.querySelector('[data-tab-count]');
    if (!badge) return;
    n = typeof n === 'number' && isFinite(n) && n > 0 ? Math.floor(n) : 0;
    badge.textContent = n ? String(n) : '';
    badge.hidden = !n;
    if (n) a.setAttribute('aria-label', TITLES[id] + ' ' + n + ' waiting');
    else a.removeAttribute('aria-label');
  }

  function loadCounts() {
    var sig = signal;
    fetch('/api/admin/access-requests/count', { credentials: 'same-origin', signal: sig }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (d) {
      if (d && !sig.aborted) setCount('access-requests', d.pending);
    }, function () { /* the badge stays as it was; the tab still loads its own list */ });
  }
```

add `setCount: setCount` to the `WSSettings` object, and call `loadCounts();` at the end of `init` (after `load();`). If `settings_books.mjs` or `settings_frost.mjs` treat the new request as unexpected, teach their fake servers to answer `/api/admin/access-requests/count` with `{ pending: 0 }`.

- [ ] **Step 5: The tab module**

Create `app/static/js/settings/access-requests.js`:

```js
/**
 * Settings > Access requests: who asked for access from the sign-in page,
 * and the admin's answer (docs/superpowers/specs/2026-10-10-request-access-design.md,
 * section 9). The switch and the default libraries are settings (the save
 * bar saves them); Approve, Deny and Unblock are actions with their own
 * buttons. Everything a requester typed, and everything from Plex, is set
 * as text.
 *
 * The tab waits (briefly) for its list and the server's libraries. Approve
 * opens only once Plex has listed the libraries: a dialog with nothing to
 * tick would share nothing.
 */
(function () {
  'use strict';

  var el = WSSettings.el, cls = WSSettings.cls;
  var TAB = 'access-requests';
  var BASE = '/api/admin/access-requests';
  var KEY_ON = 'access_requests.enabled';
  var KEY_LIBS = 'access_requests.default_libraries';
  var LOAD_WAIT = 3000;
  var CHECK = 'h-5 w-5 shrink-0 rounded border-frosted-blue/30 bg-transparent text-primary focus:ring-focus';
  var CHECK_ROW = 'flex items-center gap-3 min-h-11 text-[15px] text-frosted-blue cursor-pointer';
  var CARD = 'rounded-2xl border border-frosted-blue/10 bg-frosted-blue/[0.04] p-4 sm:p-5 min-w-0';

  var MSG = {
    needsPlex: 'This needs Plex. Connect it under Integrations first.',
    loadFailed: 'This couldn’t load. Try again in a moment.',
    libsFailed: 'Plex didn’t list your libraries, so nobody can be approved right now. Try again in a moment.',
    noLibs: 'Plex lists no libraries on your server.',
    noneWaiting: 'Nobody is waiting.',
    noneDecided: 'No answers in the last 30 days.',
    pickOne: 'Pick at least one library.',
    offline: 'That didn’t go through. Check your connection and try again.',
    shared: 'Approved. Plex sent them an invite.',
    existing: 'Approved. They already had access in Plex.',
    shareFailed: 'Approved, but Plex didn’t share. Share it in Plex yourself.',
    denied: 'Denied. They can ask again in 30 days.',
    blocked: 'Blocked. That Plex account can’t ask again.',
    unblocked: 'Unblocked. They can ask again.',
    copyFailed: 'Couldn’t copy. Their Plex username is on the card.'
  };

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function ago(iso) {
    var t = Date.parse(iso || '');
    if (!t) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return plural(m, 'minute', 'minutes') + ' ago';
    var h = Math.round(s / 3600);
    if (h < 24) return plural(h, 'hour', 'hours') + ' ago';
    return plural(Math.round(s / 86400), 'day', 'days') + ' ago';
  }

  function day(iso) {
    var d = new Date(iso || '');
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function arr(v) { return Array.isArray(v) ? v : []; }

  // The body as JSON, or {} for an empty body or an error page.
  function readJson(r) {
    return r.text().then(function (text) {
      var d = null;
      try { d = text ? JSON.parse(text) : null; } catch (e) { d = null; }
      return { status: r.status, ok: r.ok, d: d && typeof d === 'object' ? d : {} };
    }, function () { return { status: r.status, ok: r.ok, d: {} }; });
  }

  function tickedIn(box) {
    return Array.prototype.filter.call(box.querySelectorAll('input[type="checkbox"]'), function (b) {
      return b.checked;
    }).map(function (b) { return b.value; });
  }

  WSSettings.registerTab(TAB, {
    // ctx: the page's (the kit passes it on each visit). Every listener and
    // request ends with its signal.
    mount: function (panel, api, ctx) {
      var signal = ctx.signal;
      var libraries = null;          // [{key, title, type}] once Plex lists them
      var libsFailed = false;
      var data = { pending: [], decided: [], blocked: [] };
      var busy = {};                 // request id: an answer is being given

      function checkRow(lib, checked, onChange) {
        var label = el('label', CHECK_ROW);
        var box = el('input', CHECK);
        box.type = 'checkbox';
        box.value = lib.key;
        box.checked = checked;
        if (onChange) box.addEventListener('change', onChange, { signal: signal });
        label.appendChild(box);
        label.appendChild(el('span', 'min-w-0 break-words', lib.title || 'Library ' + lib.key));
        return label;
      }

      function currentDefaults() {
        try {
          var keys = JSON.parse(api.get(KEY_LIBS) || '[]');
          return Array.isArray(keys) ? keys : [];
        } catch (e) { return []; }
      }

      // ---- The switch ----

      var sw = WSSettings.card('Sign-in page', 'Let people who don’t have access yet ask for it from the sign-in card.');
      sw.body.appendChild(api.toggle({ key: KEY_ON, label: 'Let people request access from the sign-in page' }));
      var needsPlex = el('p', cls.help, MSG.needsPlex);
      needsPlex.setAttribute('data-ar-needs-plex', '');
      needsPlex.hidden = !!(api.saved('integration.plex.url') && api.saved('integration.plex.token'));
      sw.body.appendChild(needsPlex);
      panel.appendChild(sw.root);

      // ---- Default libraries (a setting) ----

      var defaults = WSSettings.card('Default libraries', 'Ticked for a new person when you approve them. You can change them for each person.');
      var libsBox = el('div', 'space-y-2');
      libsBox.setAttribute('data-ar-defaults', '');
      var libsNote = el('p', cls.help);
      libsNote.setAttribute('role', 'status');
      var libsError = el('p', cls.help);
      defaults.body.appendChild(libsBox);
      defaults.body.appendChild(libsNote);
      defaults.body.appendChild(libsError);
      panel.appendChild(defaults.root);

      function paintDefaults() {
        libsBox.replaceChildren();
        if (!libraries) {
          libsNote.textContent = libsFailed ? MSG.libsFailed : '';
          return;
        }
        libsNote.textContent = libraries.length ? '' : MSG.noLibs;
        var on = currentDefaults();
        libraries.forEach(function (lib) {
          libsBox.appendChild(checkRow(lib, on.indexOf(lib.key) !== -1, function () {
            api.set(KEY_LIBS, JSON.stringify(tickedIn(libsBox)));
          }));
        });
      }
      api.track(KEY_LIBS, { get: function () { return JSON.stringify(tickedIn(libsBox)); },
                            set: function () { paintDefaults(); }, el: libsBox, errorEl: libsError });

      // ---- Waiting and Decided ----

      var waiting = WSSettings.card('Waiting', 'People who asked for access. Approving shares your Plex server with them.');
      var waitingList = el('div', 'space-y-3');
      waitingList.setAttribute('data-ar-waiting', '');
      waitingList.appendChild(el('span', 'skel skel-line block w-64 max-w-full'));
      waiting.body.appendChild(waitingList);
      panel.appendChild(waiting.root);

      var decided = WSSettings.card('Decided', 'Answers from the last 30 days, and the accounts you blocked.');
      var decidedList = el('div', 'space-y-3');
      decidedList.setAttribute('data-ar-decided', '');
      decided.body.appendChild(decidedList);
      panel.appendChild(decided.root);

      function who(r) {
        var head = el('div', 'flex items-center gap-3 min-w-0');
        if (r.avatar_url) {
          var img = el('img', 'h-10 w-10 shrink-0 rounded-full object-cover');
          img.alt = '';
          img.src = r.avatar_url;
          head.appendChild(img);
        }
        var names = el('div', 'min-w-0');
        names.appendChild(el('p', 'text-[15px] font-semibold text-frosted-blue break-words', r.plex_username));
        if (r.plex_email) names.appendChild(el('p', 'text-[13px] text-frosted-blue/70 break-all', r.plex_email));
        head.appendChild(names);
        return head;
      }

      function requestCard(r) {
        var card = el('article', CARD);
        card.setAttribute('data-ar-request', String(r.id));
        card.appendChild(who(r));
        var name = el('p', 'mt-3 text-[15px] text-frosted-blue break-words');
        name.appendChild(el('span', 'text-frosted-blue/70', 'Name: '));
        name.appendChild(document.createTextNode(r.name || ''));
        card.appendChild(name);
        var note = el('p', 'mt-1 text-[15px] text-frosted-blue whitespace-pre-line break-words', r.note || '');
        note.setAttribute('data-ar-note', '');
        card.appendChild(note);
        card.appendChild(el('p', 'mt-2 text-[13px] text-frosted-blue/60', 'Sent ' + ago(r.created_at)));
        var row = el('div', 'mt-4 flex flex-wrap gap-2');
        var approve = el('button', cls.btnPrimary, 'Approve');
        approve.type = 'button';
        approve.setAttribute('data-ar-approve', '');
        approve.setAttribute('aria-label', 'Approve ' + r.plex_username);
        approve.addEventListener('click', function () { approveIt(r, approve); }, { signal: signal });
        var deny = el('button', cls.btnGhost, 'Deny');
        deny.type = 'button';
        deny.setAttribute('data-ar-deny', '');
        deny.setAttribute('aria-label', 'Deny ' + r.plex_username);
        deny.addEventListener('click', function () { denyIt(r, deny); }, { signal: signal });
        row.appendChild(approve);
        row.appendChild(deny);
        card.appendChild(row);
        return card;
      }

      function outcome(r) {
        if (r.status === 'approved') {
          return 'Approved ' + ago(r.decided_at) + (r.share_state === 'shared' ? '. Plex sent the invite.'
            : r.share_state === 'existing' ? '. They already had access.' : '.');
        }
        if (r.status === 'denied') return 'Denied ' + ago(r.decided_at) + '. They can ask again after ' + day(r.can_ask_after) + '.';
        if (r.status === 'blocked') return 'Blocked ' + ago(r.decided_at) + '.';
        return '';
      }

      function decidedRow(r) {
        var item = el('article', CARD);
        item.setAttribute('data-ar-decided-row', String(r.id));
        item.appendChild(who(r));
        item.appendChild(el('p', 'mt-2 text-[13px] text-frosted-blue/70 break-words', outcome(r)));
        if (r.status === 'approved' && r.share_state === 'failed') {
          var reason = el('p', 'mt-1 text-[13px] text-status-err-text break-words', r.share_error || 'Plex didn’t share.');
          reason.setAttribute('data-ar-share-error', '');
          item.appendChild(reason);
          var copy = el('button', cls.btnGhost + ' mt-3', 'Share it in Plex yourself');
          copy.type = 'button';
          copy.setAttribute('data-ar-copy', '');
          copy.addEventListener('click', function () { copyName(r.plex_username); }, { signal: signal });
          item.appendChild(copy);
        }
        if (r.status === 'blocked') {
          var un = el('button', cls.btnGhost + ' mt-3', 'Unblock');
          un.type = 'button';
          un.setAttribute('data-ar-unblock', '');
          un.setAttribute('aria-label', 'Unblock ' + r.plex_username);
          un.addEventListener('click', function () { unblockIt(r, un); }, { signal: signal });
          item.appendChild(un);
        }
        return item;
      }

      function paintLists() {
        waitingList.replaceChildren();
        if (!data.pending.length) waitingList.appendChild(el('p', 'text-[15px] text-frosted-blue/70', MSG.noneWaiting));
        data.pending.forEach(function (r) { waitingList.appendChild(requestCard(r)); });
        decidedList.replaceChildren();
        var rows = data.decided.concat(data.blocked);
        if (!rows.length) decidedList.appendChild(el('p', 'text-[15px] text-frosted-blue/70', MSG.noneDecided));
        rows.forEach(function (r) { decidedList.appendChild(decidedRow(r)); });
        WSSettings.setCount(TAB, data.pending.length);
      }

      function retryBox(text, again) {
        var box = el('div', 'flex flex-wrap items-center gap-3');
        box.appendChild(el('p', 'text-[15px] text-frosted-blue/70', text));
        var b = el('button', cls.btnQuiet, 'Try again');
        b.type = 'button';
        b.addEventListener('click', again, { signal: signal });
        box.appendChild(b);
        return box;
      }

      // ---- The server ----

      function get(path) {
        return fetch(BASE + path, { credentials: 'same-origin', signal: signal }).then(readJson, function () {
          return { status: 0, ok: false, d: {} };
        });
      }

      function post(path, body) {
        var init = { method: 'POST', credentials: 'same-origin', signal: signal, headers: {} };
        if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
        return fetch(BASE + path, init).then(readJson, function () { return { status: 0, ok: false, d: {} }; });
      }

      function leaveIf401(res) {
        if (res && res.status === 401) { WSSettings.leave('/login'); return true; }
        return false;
      }

      function failed(res) {
        var detail = res.d && typeof res.d.detail === 'string' ? res.d.detail : '';
        WSSettings.toast(detail || (res.status ? MSG.loadFailed : MSG.offline), 'err');
      }

      function loadLists() {
        return get('').then(function (res) {
          if (signal.aborted || leaveIf401(res)) return;
          if (!res.ok) { waitingList.replaceChildren(retryBox(MSG.loadFailed, loadLists)); return; }
          data = { pending: arr(res.d.pending), decided: arr(res.d.decided), blocked: arr(res.d.blocked) };
          paintLists();
        });
      }

      function loadLibraries() {
        return get('/libraries').then(function (res) {
          if (signal.aborted || leaveIf401(res)) return;
          libsFailed = !res.ok;
          libraries = res.ok ? arr(res.d.libraries).filter(function (l) { return l && typeof l.key === 'string'; }) : null;
          paintDefaults();
        });
      }

      // ---- Answers ----

      function approveIt(r, button) {
        if (busy[r.id]) return;
        if (!libraries || !libraries.length) {
          WSSettings.toast(libraries ? MSG.noLibs : MSG.libsFailed, 'err');
          loadLibraries();
          return;
        }
        busy[r.id] = true;
        var fs = el('fieldset', 'mt-2 space-y-2');
        fs.appendChild(el('legend', 'text-[13px] font-semibold text-frosted-blue/70 mb-1', 'Libraries ' + r.plex_username + ' gets'));
        var on = currentDefaults();
        libraries.forEach(function (lib) { fs.appendChild(checkRow(lib, on.indexOf(lib.key) !== -1, null)); });
        WSSettings.confirm({ title: 'Approve ' + r.plex_username + '?', body: fs, confirmLabel: 'Share and approve' }).then(function (ok) {
          if (!ok) { busy[r.id] = false; return; }
          var keys = tickedIn(fs);
          if (!keys.length) { busy[r.id] = false; WSSettings.toast(MSG.pickOne, 'err'); return; }
          button.disabled = true;
          return post('/' + r.id + '/approve', { library_keys: keys }).then(function (res) {
            busy[r.id] = false;
            if (signal.aborted || leaveIf401(res)) return;
            button.disabled = false;
            if (!res.ok) { failed(res); return loadLists(); }
            var state = res.d.share_state;
            WSSettings.toast(state === 'failed' ? MSG.shareFailed : state === 'existing' ? MSG.existing : MSG.shared,
                             state === 'failed' ? 'err' : 'ok');
            return loadLists();
          });
        });
      }

      function denyIt(r, button) {
        if (busy[r.id]) return;
        busy[r.id] = true;
        var body = el('div', 'space-y-3');
        body.appendChild(el('p', '', r.plex_username + ' can ask again in 30 days.'));
        var label = el('label', CHECK_ROW);
        var block = el('input', CHECK);
        block.type = 'checkbox';
        block.setAttribute('data-ar-block', '');
        label.appendChild(block);
        label.appendChild(el('span', '', 'Block this Plex account for good'));
        body.appendChild(label);
        WSSettings.confirm({ title: 'Deny ' + r.plex_username + '?', body: body, confirmLabel: 'Deny' }).then(function (ok) {
          if (!ok) { busy[r.id] = false; return; }
          button.disabled = true;
          var forGood = block.checked;
          return post('/' + r.id + '/deny', { block: forGood }).then(function (res) {
            busy[r.id] = false;
            if (signal.aborted || leaveIf401(res)) return;
            button.disabled = false;
            if (!res.ok) { failed(res); return loadLists(); }
            WSSettings.toast(forGood ? MSG.blocked : MSG.denied, 'ok');
            return loadLists();
          });
        });
      }

      function unblockIt(r, button) {
        if (busy[r.id]) return;
        busy[r.id] = true;
        button.disabled = true;
        post('/' + r.id + '/unblock').then(function (res) {
          busy[r.id] = false;
          if (signal.aborted || leaveIf401(res)) return;
          button.disabled = false;
          if (!res.ok) { failed(res); return loadLists(); }
          WSSettings.toast(MSG.unblocked, 'ok');
          return loadLists();
        });
      }

      function copyName(username) {
        var clip = window.navigator.clipboard;
        if (!clip || !clip.writeText) { WSSettings.toast(MSG.copyFailed, 'err'); return; }
        clip.writeText(username).then(function () {
          WSSettings.toast('Copied ' + username + '. Share your server with them in Plex.', 'ok');
        }, function () { WSSettings.toast(MSG.copyFailed, 'err'); });
      }

      var ready = Promise.all([loadLists(), loadLibraries()]);
      return Promise.race([ready, new Promise(function (resolve) { ctx.setTimeout(resolve, LOAD_WAIT); })]);
    }
  });
})();
```

- [ ] **Step 6: Wire the test in and rebuild the CSS**

Add `node app/tests/js/settings_access.mjs` to the end of `package.json` `test:js` and of the CI `js-checks` list.
Run: `npm run build:css`
Expected: `app.css` rebuilt.

- [ ] **Step 7: Run the front-end tests**

Run: `node app/tests/js/settings_access.mjs`
Expected: `N/N settings access cases pass`.
Run: `npm run test:js`
Expected: every file passes.

- [ ] **Step 8: Commit**

```bash
git add app/static/settings.html app/static/js/settings/first-paint.js app/static/js/settings/kit.js app/static/js/settings/access-requests.js app/static/css/theme.css app/static/css/app.css app/tests/test_settings_static.py package.json .github/workflows/docker-publish.yml app/tests/js/settings_access.mjs
git commit -m "feat(access): Settings > Access requests, with a count on its tab"
```
(Add `app/tests/js/settings_books.mjs` and `app/tests/js/settings_frost.mjs` to the `git add` only if Step 4 had to teach them the count request.)

- [ ] **Step 9: Deploy to dev and check**

Deploy sequence (no restart: static files only). Run on dev, each its own command: `app.tests.test_settings_static`, `app.tests.test_settings_gate`, `app.tests.test_icon_font`, `app.tests.test_css_build`, `app.tests.test_shell_contract`, then the full suite. Expected: all green. CI green.

### Task 11: Whole-feature live check at 390 and 1440, the end-to-end run, CI green

Everything is on dev by now. This task checks it the way a person meets it, at 390 and 1440 wide, then runs the one real end-to-end request with Jordan's test account, with Jordan present. It changes dev settings only with Jordan's approval and puts them back after.

**Files:**
- Create (scratch, never committed): `$SCRATCH/ra-live.mjs`
- Modify: `docs/superpowers/specs/2026-10-10-request-access-design.md` (status line: built and live-checked)

**Interfaces:** consumes everything above. Produces the evidence for the report to Jordan.

- [ ] **Step 1: Ask Jordan for the dev changes and a time**

"Waiting on you: for the request access live check on dev I need to (1) turn on Settings > Access requests and move the sign-in card left and right for a few minutes, all put back afterwards from a snapshot, and (2) one real run with `jordanfromit912`: you request access with it in a private window, approve it in Settings with one library, accept the invite, sign in, then remove the share in Plex. OK to do (1) now, and when are you free for (2)?" Stop until he answers. Do (1) only after a yes; do (2) only with Jordan present.

- [ ] **Step 2: Snapshot dev and turn the feature on**

Each its own command:
`ssh webserver "docker exec -i webservarr-dev python - snapshot ra-live < ~/webservarr-dev/scripts/devkit/devkit.py"`
Expected: `snapshot ra-live: N tables, M rows`.

The settings change goes through the app as an admin (script mode, Step 3's script with mode `settings`), never by editing the database.

- [ ] **Step 3: Write the live script**

`$SCRATCH/ra-live.mjs`:

```js
// Request access, live on dev (Task 11). Modes:
//   settings <key> <value>   an admin saves one setting (with Jordan's approval only)
//   card <outdir>            the sign-in card at 390 and 1440, every step, signed out
//   admin <outdir>           Settings > Access requests at 390 and 1440, approve intercepted
//   member                   a member can't reach the tab or its API
//   peek                     read-only: who is waiting, and the newest answers
// Run through ws-dev-browser (script mode), with WS_KIT set to this worktree's
// scripts/devkit/browser.mjs.
const { launch } = await import(process.env.WS_KIT);
const [mode, a1, a2] = process.argv.slice(2);
const failures = [];
const check = (what, ok, info) => { if (!ok) failures.push(what + (info === undefined ? '' : ' ' + JSON.stringify(info))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launch();

async function tabTo(dataAttr, limit = 25) {
  for (let i = 0; i < limit; i++) {
    await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    if (await b.evaluate(`!!(document.activeElement && document.activeElement.hasAttribute(${JSON.stringify(dataAttr)}))`)) return true;
  }
  return false;
}
async function press(key, code, vk) {
  await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
  await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  await sleep(300);
}
const visibleStep = `(() => { const s = [...document.querySelectorAll('[data-ra-step]')].find((n) => !n.hidden);
  return s ? s.getAttribute('data-ra-step') : (document.getElementById('requestAccess').hidden ? 'signin' : 'none'); })()`;
async function shoot(dir, name, width) {
  const m = await b.measure();
  check(`${name}@${width}: no sideways scroll`, !m.overflow.overflows, m.overflow);
  check(`${name}@${width}: no console errors`, m.consoleErrors.filter((e) => !/Failed to load resource/.test(e)).length === 0, m.consoleErrors);
  await b.screenshot(`${dir}/${name}-${width}.png`, { fullPage: true });
}
async function landOn(answer, width) {
  await b.clearIntercepts();
  await b.intercept('*/api/access-requests/identify', 200, { body: JSON.stringify(answer) });
  await b.goto('/login', { width });
  await b.evaluate(`sessionStorage.setItem('access_pin_id', '1')`);
  await b.goto('/login?access_request=complete', { width });
  await sleep(500);
}

try {
  if (mode === 'settings') {
    await b.setSession(process.env.DEVKIT_COOKIE);
    await b.goto('/settings', { width: 1440 });
    const status = await b.evaluate(`fetch('/api/admin/settings/bulk', { method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: [{ key: ${JSON.stringify(a1)}, value: ${JSON.stringify(a2)} }] }) }).then((r) => r.status)`);
    check(`saved ${a1}`, status === 200, status);
  } else if (mode === 'card') {
    for (const width of [390, 1440]) {
      await b.clearIntercepts();
      await b.goto('/login', { width });
      check(`S0@${width}: the link shows`, await b.evaluate(`!document.getElementById('requestAccessLinkRow').hidden`));
      await shoot(a1, 'S0', width);
      // Keyboard only: Tab to the link, Enter, and focus lands on the heading.
      check(`S0@${width}: the link is reachable by Tab`, await b.evaluate(`document.getElementById('requestAccessLink').tabIndex >= 0`));
      await b.evaluate(`document.getElementById('requestAccessLink').focus()`);
      await press('Enter', 'Enter', 13);
      check(`S1@${width}`, (await b.evaluate(visibleStep)) === 'intro');
      check(`S1@${width}: focus on the heading`, await b.evaluate(`document.activeElement.hasAttribute('data-ra-heading')`));
      check(`S1@${width}: announced`, (await b.evaluate(`document.getElementById('raLive').textContent`)) === 'Request access');
      check(`S1@${width}: Tab reaches Continue with Plex`, await tabTo('data-ra-plex'));
      await shoot(a1, 'S1', width);
      // S2: the PIN is faked and the window is opened without a click, so the browser blocks it.
      await b.intercept('*/api/access-requests/pin', 200, { body: JSON.stringify({ pin_id: 1, auth_url: '/static/webservarr.svg' }) });
      await b.evaluate(`document.querySelector('[data-ra-plex]').dispatchEvent(new MouseEvent('click'))`);
      await sleep(500);
      check(`S2@${width}`, (await b.evaluate(visibleStep)) === 'waiting');
      await shoot(a1, 'S2-blocked', width);
      // S3, then S4 with the send intercepted (nothing reaches the server).
      await landOn({ state: 'new', username: 'devkit-test', avatar_url: '' }, width);
      check(`S3@${width}`, (await b.evaluate(visibleStep)) === 'form');
      await b.evaluate(`(() => { const n = document.getElementById('raName'); n.value = 'Devkit Person';
        const t = document.getElementById('raNote'); t.value = 'x'.repeat(400) + '\\n' + 'word '.repeat(120);
        t.dispatchEvent(new Event('input')); })()`);
      await shoot(a1, 'S3', width);
      await b.intercept('*/api/access-requests', 200, { body: JSON.stringify({ state: 'pending', sent: true }) });
      await b.evaluate(`document.querySelector('[data-ra-send]').click()`);
      await sleep(500);
      check(`S4@${width}`, (await b.evaluate(visibleStep)) === 'sent');
      await shoot(a1, 'S4', width);
      for (const state of ['pending', 'approved', 'invited', 'denied', 'blocked', 'member']) {
        await landOn({ state, username: 'x', avatar_url: '', submitted_at: new Date().toISOString(),
                       can_ask_after: new Date(Date.now() + 30 * 86400000).toISOString() }, width);
        check(`S5 ${state}@${width}`, (await b.evaluate(visibleStep)) === 'status');
        await shoot(a1, `S5-${state}`, width);
      }
    }
  } else if (mode === 'admin') {
    await b.setSession(process.env.DEVKIT_COOKIE);
    for (const width of [390, 1440]) {
      await b.clearIntercepts();
      // Approve would share the real Plex server with whoever holds a seeded username: never let it through.
      await b.intercept('*/api/admin/access-requests/*/approve', 200, { body: JSON.stringify({ status: 'approved', share_state: 'failed', share_error: 'intercepted in the live check' }) });
      await b.goto('/settings#access-requests', { width });
      await sleep(1500);
      check(`tab@${width}: the badge`, (await b.evaluate(`document.querySelector('#tab-access-requests').getAttribute('aria-label')`)) === 'Access requests 2 waiting');
      check(`tab@${width}: two waiting`, (await b.evaluate(`document.querySelectorAll('[data-ar-request]').length`)) === 2);
      await shoot(a1, 'admin-tab', width);
      await b.evaluate(`document.querySelector('[data-ar-approve]').click()`);
      await sleep(800);
      check(`approve dialog@${width}`, await b.evaluate(`!!document.querySelector('.ws-dialog:not(.is-closing) input[type="checkbox"]')`));
      await shoot(a1, 'admin-approve-dialog', width);
      await press('Escape', 'Escape', 27);
      await b.evaluate(`document.querySelector('[data-ar-deny]').click()`);
      await sleep(800);
      await shoot(a1, 'admin-deny-dialog', width);
      await press('Escape', 'Escape', 27);
      check(`nothing was approved@${width}`, (await b.evaluate(`document.querySelectorAll('[data-ar-request]').length`)) === 2);
    }
  } else if (mode === 'peek') {
    // Read-only: how many wait, and the newest answers, by username only (no emails).
    await b.setSession(process.env.DEVKIT_COOKIE);
    await b.goto('/settings', { width: 1440 });
    const seen = await b.evaluate(`fetch('/api/admin/access-requests', { credentials: 'same-origin' }).then((r) => r.json())
      .then((d) => ({ pending: d.pending.map((r) => r.plex_username),
                      decided: d.decided.slice(0, 3).map((r) => [r.plex_username, r.status, r.share_state]) }))`);
    console.log(JSON.stringify(seen));
  } else if (mode === 'member') {
    await b.setSession(process.env.DEVKIT_COOKIE);
    await b.goto('/settings#access-requests', { width: 1440 });
    check('a member is sent away from Settings', !(await b.evaluate(`location.pathname`)).startsWith('/settings'));
    const status = await b.evaluate(`fetch('/api/admin/access-requests', { credentials: 'same-origin' }).then((r) => r.status)`);
    check('a member gets 403 from the API', status === 403, status);
  }
} finally {
  await b.close();
}
console.log(failures.length ? 'FAILURES:\n' + failures.join('\n') : 'all live checks pass');
process.exit(failures.length ? 1 : 0);
```

- [ ] **Step 4: Turn the feature on (approved in Step 1)**

Run (check `pgrep -f ws-dev-browser` first; one at a time): `WS_KIT=$PWD/scripts/devkit/browser.mjs ws-dev-browser -- $SCRATCH/ra-live.mjs settings access_requests.enabled true`
Expected: `all live checks pass`.

- [ ] **Step 5: The card, centred, at 390 and 1440 (signed out)**

Run: `WS_KIT=$PWD/scripts/devkit/browser.mjs ws-dev-browser -- $SCRATCH/ra-live.mjs card $SCRATCH/shots/centre`
Expected: `all live checks pass`. Look at every screenshot: the card keeps its frost, logo and width; nothing overflows; the long note wraps; S5 words match spec section 9.

- [ ] **Step 6: The card left and right**

Each its own command, one at a time:
`WS_KIT=$PWD/scripts/devkit/browser.mjs ws-dev-browser -- $SCRATCH/ra-live.mjs settings login.card_position left`
`WS_KIT=$PWD/scripts/devkit/browser.mjs ws-dev-browser -- $SCRATCH/ra-live.mjs card $SCRATCH/shots/left`
`WS_KIT=$PWD/scripts/devkit/browser.mjs ws-dev-browser -- $SCRATCH/ra-live.mjs settings login.card_position right`
`WS_KIT=$PWD/scripts/devkit/browser.mjs ws-dev-browser -- $SCRATCH/ra-live.mjs card $SCRATCH/shots/right`
Expected: each `all live checks pass`; at 1440 the card sits left, then right; at 390 it stays centred.

- [ ] **Step 7: The admin tab with seeded requests**

Seed, each its own command:
`ssh webserver "docker exec -i webservarr-dev python - seed-access --identity plex:990011 < ~/webservarr-dev/scripts/devkit/devkit.py"`
`ssh webserver "docker exec -i webservarr-dev python - seed-access --identity plex:990012 --minutes-ago 90 < ~/webservarr-dev/scripts/devkit/devkit.py"`
`ssh webserver "docker exec -i webservarr-dev python - seed-access --identity plex:990013 --status approved --share-state failed --share-error 'Plex refused the share (HTTP 400)' < ~/webservarr-dev/scripts/devkit/devkit.py"`
`ssh webserver "docker exec -i webservarr-dev python - seed-access --identity plex:990014 --status denied < ~/webservarr-dev/scripts/devkit/devkit.py"`
`ssh webserver "docker exec -i webservarr-dev python - seed-access --identity plex:990015 --status blocked < ~/webservarr-dev/scripts/devkit/devkit.py"`
Then: `WS_KIT=$PWD/scripts/devkit/browser.mjs ws-dev-browser -- $SCRATCH/ra-live.mjs admin $SCRATCH/shots/admin`
Expected: `all live checks pass` (ws-dev-browser's cleanup then deletes the seeded rows). Look at the screenshots: badge, cards, the note's line breaks, the failed row's reason and button, the dialogs at 390.

- [ ] **Step 8: A member**

Run: `WS_KIT=$PWD/scripts/devkit/browser.mjs ws-dev-browser --role member -- $SCRATCH/ra-live.mjs member`
Expected: `all live checks pass`.

- [ ] **Step 9: The end-to-end run with Jordan (only with Jordan present)**

1. Jordan, in a private window on the dev site, uses "New here? Request access" with `jordanfromit912` and sends a request.
2. The agent confirms it arrived, read-only: `WS_KIT=$PWD/scripts/devkit/browser.mjs ws-dev-browser -- $SCRATCH/ra-live.mjs peek`. Expected: `jordanfromit912` in `pending`.
3. Jordan checks that his bell and a push arrived (spec section 8: he must have signed in to dev once since Task 6 shipped, so his admin contact exists).
4. Jordan approves it in Settings > Access requests with one library. Jordan clicks, never the agent.
5. The agent runs `peek` again. Expected: `["jordanfromit912", "approved", "shared"]` first in `decided`.
6. Jordan accepts the invite, signs in to dev with the test account (expected: in), and then removes the share in Plex himself.
7. Record each result for the report.

- [ ] **Step 10: Put dev back**

Each its own command:
`ssh webserver "docker exec -i webservarr-dev python - restore ra-live < ~/webservarr-dev/scripts/devkit/devkit.py"`
Expected: `restored ra-live: ... rows in ... tables, N kit sessions deleted`.
`ws-dev-browser --cleanup`
Expected: the kit's rows and sessions gone. The end-to-end request row for the test account stays (approved rows are tidied after 30 days).

- [ ] **Step 11: CI on the latest dev commit**

Run: `gh run list --branch dev --limit 1`, then `gh run watch <run id> --exit-status`.
Expected: success (`test` and `js-checks` green).

- [ ] **Step 12: Record it and commit**

In the spec's status line, replace "Not built." with "Built and live-checked on dev <date> (390 and 1440, all three card positions, keyboard, admin and member; one end-to-end request with Jordan's test account)." Commit and push:

```bash
git add docs/superpowers/specs/2026-10-10-request-access-design.md
git commit -m "docs(spec): request access is built and live-checked on dev"
```

Report to Jordan, first line the true status, with the screenshots' folder and any failure. Remind him the feature joins the v2.0 security audit scope: the three public routes (`POST /api/access-requests/pin`, `/identify`, `POST /api/access-requests`), the identify flow and the callback page's `for=access` branch. The audit itself is not part of this plan.
