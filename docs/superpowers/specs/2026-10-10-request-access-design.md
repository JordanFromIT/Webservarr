# Request access from the sign-in page

Status: designed 2026-10-10; decisions approved by Jordan in chat. Amended 2026-10-10: the admin's
notifications find the admin by Plex account id, not by email (section 8). Not built. The build plan is
`docs/superpowers/plans/2026-10-10-request-access.md`. This feature adds public
routes, so it joins the v2.0 security audit scope (roadmap step 6). The audit stays on hold until Jordan
says it is ready.

## 1. Purpose and success criteria

A stranger can ask for access from the sign-in page, and the admin can approve or deny the request
inside WebServarr. Approving shares the Plex server with that person, so they can then sign in the
normal way.

The feature is done when all of these hold:

- With the feature switched on, a visitor can request access from inside the existing frosted sign-in
  card. They prove their Plex account with the Plex PIN popup, fill in a short form, and see "Request
  sent: watch your email for the Plex invite." If they come back later and do the popup again, they see
  their status.
- With the feature switched off, the sign-in page looks exactly as it does today, and every request
  route refuses on the server.
- The admin sees each new request in Settings > Access requests, in the bell list and as a push. They
  can approve with a library picker, which shares the server through Plex, or they can deny.
- Normal sign-in stays Authentik-only and doesn't change. The flow never creates a WebServarr session,
  and the requester's Plex token is never stored, logged or returned.

## 2. Decisions (Jordan)

- **Flow:** a stranger requests from the sign-in page. The admin approves or denies in WebServarr.
- **Identity:** the requester proves their Plex account with the Plex PIN popup. WebServarr reads only
  the Plex account id, username, email and avatar from that token, then throws the token away. The
  flow creates no session. Sign-in stays Authentik-only; Plex PIN is not a sign-in method.
- **Form:** after the popup, the requester gives their name and a required answer to "Who are you and
  how do you know us?".
- **After submitting:** the card says "Request sent: watch your email for the Plex invite." Doing the
  popup again later shows the status (pending, approved or denied).
- **Admin side:** a new "Access requests" section in Settings, admin only and enforced on the server
  like the rest of `/api/admin`, with a count badge. Each new request also goes to the admin's bell
  list and push, through the existing notification system.
- **Approve:** opens a library picker with the default library set (configured in Settings) already
  ticked. The admin can untick or add libraries for that person. WebServarr then shares the Plex
  server with that exact Plex account and the ticked libraries, using the admin Plex token and calling
  Plex directly (no Wizarr, no new container). If Plex refuses or errors, the request stays "approved"
  and the admin gets a "Share it in Plex yourself" button that copies the username.
- **Deny:** the same Plex account can't request again for 30 days. The admin can also block an
  account permanently.
- **No Seerr import.** Seerr has new Plex sign-in turned on with request permissions by default, and
  WebServarr already signs each user into Seerr with their Plex token
  (`app/integrations/seerr.py` `authenticate_with_plex_token`). Seerr creates the user on first use.
- **Abuse limits:** per-device/IP rate limits, at most 20 open requests at once, and one open request
  per Plex account. The Plex popup is the bot filter. A device can't be identified reliably (cookies
  can be cleared), so the rate limits are keyed on the client IP, the same key the rest of the app
  uses.
- **Feature switch:** in Settings, off by default.
- **Front end:** the whole flow lives inside the existing frosted sign-in card (`app/static/login.html`,
  `app/static/js/login.js`). There is no new page. The card's content changes step by step, there is a
  clear way back to sign-in, and the card uses the current frost recipe and theme tokens. It must work
  at 390 and 1440 wide, and with a keyboard and a screen reader. A mockup that Jordan approves comes
  before any front-end build (his rule: no unreviewed visual redesign).

## 3. Plex feasibility (checked read-only 2026-10-10)

These calls were made from the dev container with the admin token and the configured server, GET only.

| Endpoint | Status | What it is |
|---|---|---|
| `plex.tv/api/v2/friends` | 410 | Control: the endpoint retired in August 2026 |
| `plex.tv/api/servers/{machineId}/shared_servers` | 200 | v1 share list; python-plexapi and Wizarr POST invites to this same path |
| `plex.tv/api/servers/{machineId}` | 200 | Library sections (`id`, `key`, `title`, `type`) |
| `plex.tv/api/v2/servers/{machineId}` | 200 | JSON `librarySections` (`id`, `key`, `title`, `type`) |
| `clients.plex.tv/api/v2/shared_servers/owned/accepted` | 200 | Accepted shares: `invitedId`, `machineIdentifier`, `libraries`, `sharingSettings`, ... |
| `clients.plex.tv/api/v2/shared_servers/owned/pending` | 200 | Invites not yet accepted, same shape |
| `clients.plex.tv/api/v2/shared_servers` (and on `plex.tv`) | 405, `Allow: OPTIONS, POST` | The v2 create route exists and takes POST |
| `plex.tv/api/v2/sharings` | 404 | Not a list route (python-plexapi uses `/api/v2/sharings/{userId}` only to change or remove a share) |

**Verdict: likely feasible, not yet proven.** Every read the feature needs answers today, and both
create routes are alive. A GET can't prove that a POST creates a share for the right account with the
right libraries, so build task 1 proves it once, against a test Plex account that Jordan provides
(section 14).

**Proof (build task 1, 2026-10-10).** Run from dev with the admin token, to Jordan's test account only:

| What | Result |
|---|---|
| Create route that worked | A (v1 POST `plex.tv/api/servers/{mid}/shared_servers`), HTTP 200. The response body is XML, not JSON, so the share client confirms the share from `owned/pending` rather than parsing the reply. Route B (v2 POST `clients.plex.tv/api/v2/shared_servers`) was not needed and is untested |
| Confirmed in `owned/pending` | Yes. Both `owned/pending` and `owned/accepted` are JSON lists of entries with the same fields: `accepted`, `acceptedAt`, `allLibraries`, `deletedAt`, `id`, `inviteToken`, `invited`, `invitedEmail`, `invitedId`, `lastSeenAt`, `leftAt`, `libraries`, `machineIdentifier`, `name`, `numLibraries`, `owned`, `owner`, `ownerId`, `searchEnabled`, `serverId`, `sharingSettings`. The account is named in `invitedEmail` and the `invited` object; `invitedId` equals `invited.id`, the account's plex.tv id (the same id its earlier share carried). `inviteToken` must never be logged |
| Libraries on the entry | Exactly the one shared (`numLibraries` 1, `allLibraries` false) |
| After acceptance | Moved to `owned/accepted`: yes, same share id, `acceptedAt` set |
| Plex friend | Yes: `plex.tv/api/users` lists the account, and Jordan saw it in Plex Web as a friend with only the shared library. The account had an earlier share (since 2025-01), so this does not show whether a share alone creates a friend |
| Sign-in with the test account | WebServarr let it in (callback 302, not admin). Authentik: sign-in succeeded; the account had existed since 2025-01, so this proves the share and WebServarr's membership gate, not brand-new enrollment (that stays with Task 2's screen check) |
| Removed | Pending: Jordan removes it in Plex |

Found on the way, for later: a 401 from `plex.tv/api/v2/user` during Authentik sign-in (a token
plex.tv rejects) is answered as 503 "Plex didn't respond. Please try again." (`_fetch_plex_account`
and `oidc_callback` in `app/routers/auth.py`), and is retried once. A 401 means the token is no
good, not that Plex is down; it deserves its own "sign in with Plex again" answer and no retry. Not
part of this feature.

WebServarr's own membership gate is `_user_has_server_access` in `app/routers/auth.py`, used by both
Authentik and Plex sign-in. It lists the servers the user's own token can see
(`plex.tv/api/v2/resources`) and checks that the configured server's machine id is among them. An
invite that hasn't been accepted doesn't show up there. So an approved person has to accept the Plex
invite (from the email or in a Plex app) before they can sign in. The card's wording says so.

## 4. Data model

There is one new table, `access_requests`, with one row per Plex account. `Base.metadata.create_all`
creates it on existing databases, so no migration is needed.

| Column | Type | Notes |
|---|---|---|
| `id` | Integer PK | |
| `plex_account_id` | String(32), unique, not null | The immutable plex.tv account id. This is the key for "one open request" and for the cooldown |
| `plex_username` | String(100), not null | As Plex reported it when the request was made |
| `plex_email` | String(254), not null, default "" | |
| `plex_avatar_url` | String(500), not null, default "" | Stored only if it is `https://` on `plex.tv` or a subdomain of it; otherwise "" |
| `name` | String(80), not null | From the form |
| `note` | Text, not null | From the form, at most 1000 characters |
| `status` | String(10), not null, indexed | `pending`, `approved`, `denied` or `blocked` |
| `share_state` | String(10), null | Set on approve: `shared`, `existing` (Plex already had a share for this account) or `failed` |
| `share_error` | String(200), null | Plex's short reason when `failed`. Never contains a token |
| `library_keys` | Text (JSON list), null | The library section keys that were ticked on approve |
| `created_at` | DateTime, server default now | |
| `decided_at` | DateTime, null | |
| `decided_by` | String(64), null | The admin's `account_identity` |
| `cooldown_until` | DateTime, null | Set on deny: `decided_at` plus 30 days |

**Retention.** A tidy job in the notification poller's leader loop runs once an hour:

- `denied` rows are deleted once `cooldown_until` has passed.
- `approved` rows are deleted 30 days after `decided_at`.
- `blocked` rows stay until the admin unblocks the account, which deletes the row.
- `pending` rows stay until the admin decides.

If a submit finds a `denied` row whose cooldown has ended but which the tidy hasn't deleted yet, it
deletes that row and creates a new one.

**Never stored anywhere:** the requester's Plex token (not in the database, Redis, logs, responses or
the browser), their IP address, and the PIN nonce in plain form.

Section 8 adds a second small table, `admin_contacts`, which says where the admin's notifications go.

## 5. Settings keys

These are added to `app/settings_registry.py` in a new "Access requests" group:

- `access_requests.enabled`: bool, default `"false"`, public.
- `access_requests.default_libraries`: JSON list of Plex library section keys (digit strings), default
  `"[]"`, not public, at most 2000 characters, and every entry must match `^\d{1,10}$`.

`build_branding` adds `auth_methods.request_access`. It is true only when the switch is on and the
Plex URL and token are both set. The sign-in page reads only this flag.

## 6. Routes

All routes use the existing limiter key (`app/limiter.py`, the real client IP behind Cloudflare). Every
POST carries `require_same_origin`, and every POST with a JSON body also carries
`require_encodable_body`.

### Public (no session)

Each public route first checks the server-side gate: `access_requests.enabled` is on and Plex is
configured. If the gate fails, the route returns 403 "Access requests are closed." before doing
anything else.

| Route | Limit | What it does |
|---|---|---|
| `POST /api/access-requests/pin` | 5/minute and 20/hour | Creates a strong PIN on plex.tv. The browser binding works like `plex_start`: a nonce goes in an HttpOnly cookie `webservarr_access_pin` (5 minutes, SameSite=Lax), and only its sha256 is stored in Redis at `access_pin:{pin_id}`. Returns `{pin_id, auth_url}`, whose `forwardUrl` is `/auth/plex-callback-page?for=access` |
| `POST /api/access-requests/identify` `{pin_id}` | 60/minute | See below |
| `POST /api/access-requests` `{name, note}` | 5/hour | See below |

The PIN keys and cookies use their own namespace, so a sign-in PIN can't complete a request PIN and a
request PIN can't complete a sign-in.

**Identify** does the following, in order:

1. Checks the browser binding. A missing or mismatched cookie gets the same single error every time,
   so the route can't be used to probe which PIN ids exist.
2. Claims the PIN (`access_pin_claim:{pin_id}`, SET NX, 60 seconds; a second caller gets 409).
3. Polls plex.tv. "Not yet authorized" releases the claim and returns 400 with that detail, as the
   sign-in flow does.
4. With the token, reads `/api/v2/user` (id, username, email, thumb) and checks membership.
   Membership uses a three-way version of the existing gate: member, not member, or unknown. "Unknown"
   (the configured server id can't be found, or plex.tv errors) returns 503, so that Plex being down
   never reads as "not a member".
5. Drops the token and deletes the PIN key.
6. Works out the state for this account, in this order:
   - `member`: the account can already see the server.
   - `invited`: the admin token's `owned/pending` list holds this `invitedId` for our server. If that
     lookup fails, this step is skipped.
   - The row's status, if a row exists: `pending`, `approved`, `denied` (with `can_ask_after`, the
     cooldown date) or `blocked`.
   - Otherwise `new`.
7. For `new` only: stores a one-use ticket in Redis at `access_ticket:{sha256(ticket)}`, holding
   account id, username, email and avatar, for 15 minutes. The browser gets the ticket in an HttpOnly
   cookie `webservarr_access_ticket` (SameSite=Strict, Path `/api/access-requests`).
8. Returns `{state, username, avatar_url, submitted_at?, can_ask_after?}`. It never returns an email
   or anything about another account.

**Submit** does the following:

1. Requires and consumes the ticket cookie. If the cookie is missing or expired, it returns 400 "Your
   Plex check timed out. Start again."
2. Validates the form. `name` is 1 to 80 characters and `note` is 1 to 1000 characters, both trimmed.
   Control characters are refused, except newlines in `note`.
3. Takes a Redis lock (`access_requests:submit`, 10 seconds) and checks, in order: blocked, cooldown,
   an existing open request (pending or approved, answered with that state), and the cap of 20
   pending rows. Then it inserts a `pending` row.
4. Notifies the admins (section 8) and returns `{state: "pending"}`.

### Admin (`require_admin`, under `/api/admin`)

These work whether the feature switch is on or off, so requests that are already waiting can still be
handled after the feature is turned off.

| Route | What it does |
|---|---|
| `GET /api/admin/access-requests` | Pending requests, oldest first; then decided rows from the last 30 days and all blocked rows |
| `GET /api/admin/access-requests/count` | `{pending: n}`, for the badge |
| `GET /api/admin/access-requests/libraries` | The server's libraries from `plex.tv/api/v2/servers/{machineId}`: `key`, `title`, `type` |
| `POST .../{id}/approve` `{library_keys}` | See below |
| `POST .../{id}/deny` `{block: bool}` | Only for a `pending` row. Sets `denied` with `cooldown_until`, or `blocked` |
| `POST .../{id}/unblock` | Only for a `blocked` row. Deletes it |

The default library set is saved through the existing `PUT /api/admin/settings/bulk`.

**Approve** does the following:

1. Accepts only a `pending` row. `library_keys` must be a non-empty subset of the server's current
   libraries.
2. Claims `access_approve:{id}` (SET NX, 60 seconds) so that a double click can't share twice.
3. Sets `approved`, `decided_at`, `decided_by` and `library_keys`, and commits.
4. Calls the share client and saves the outcome in `share_state` and `share_error`.
5. Returns the row. Approval is final even when the share fails.

## 7. Plex share client

A new module, `app/integrations/plex_share.py`, with three functions:

- `list_libraries()`
- `find_share(plex_account_id)`, which returns `accepted`, `pending` or `None`
- `share_server(account, section_keys)`, which returns `(state, error)`

The module rules:

- It reads the admin token through `app/integrations/config.py`. The token goes only in the
  `X-Plex-Token` header, never in a query string. Requests carry the app's Plex client headers
  (`_plex_client_headers`). TLS is verified, every call times out after 10 seconds, and there are no
  retries on POST.
- `share_server` calls `find_share` first. If a share already exists for this account on our server,
  it makes no POST and returns `existing`.
- The create call is the one task 1 proves:
  - **Route A** is the v1 `POST plex.tv/api/servers/{machineId}/shared_servers`, with the body
    python-plexapi's `inviteFriend` sends: `invited_email` set to the account's username, library ids
    mapped from the keys through the server listing, and sync, camera upload and channels off.
  - If A fails in task 1, task 1 proves **route B**, the v2 `POST clients.plex.tv/api/v2/shared_servers`
    with `machineIdentifier`, `librarySectionIds` and `invitedId` (or `invitedEmail`), and the client
    uses B.
  - The function's contract is the same either way.
- After the POST, it calls `find_share` again. The share counts as `shared` only if Plex lists an entry
  whose `invitedId` equals the row's `plex_account_id`. Anything else is `failed` with a short reason,
  for example "Plex refused the share (HTTP 400)" or "Plex didn't confirm the share".
- Fields such as `inviteToken` and `accessToken` in Plex responses are never read into memory past the
  parse, and never logged or saved.

## 8. Notifications

- **Who the admin is.** Bell rows and push subscriptions are filed under the email of the signed-in
  session (`identity_email`). An admin who signs in through Authentik carries Authentik's email claim,
  which need not be the plex.tv owner's email. So the admin is never found by comparing emails. The
  rule is the one sign-in already uses to make someone admin: the immutable Plex account id of the
  account that owns the admin token (`_is_plex_server_owner`).
- **Admin contacts.** A small table, `admin_contacts`, joins that id to the key the bell uses. Each
  sign-in (Authentik and Plex direct) whose session is admin and carries a Plex account id records one
  row, or refreshes its `seen_at`. Recording never blocks a sign-in. A session without an email or
  without a Plex account id records nothing.

  | Column | Type | Notes |
  |---|---|---|
  | `plex_account_id` | String(32), primary key (with `notify_email`) | The session's Plex account id |
  | `notify_email` | String(200), primary key (with `plex_account_id`) | `identity_email` of the session's email: the key its bell and push use |
  | `seen_at` | DateTime, not null | The last sign-in that recorded it |

- **Recipients:** when a request comes in, WebServarr reads the owner's account id from the admin token
  (the same plex.tv call `_is_plex_server_owner` makes) and sends to every `notify_email` recorded for
  that id. No email is compared with another email anywhere in this path.
  - An admin who signed in two ways (two emails) is reached at both.
  - Someone who is admin only through the `system.admin_email` allowlist has a different Plex account
    id, so they get no bell or push. They see the Settings badge.
  - If the owner lookup fails, no bell or push goes out for that request (logged by request id). The
    badge still counts it.
  - Until the admin signs in once after this ships, there is no contact row, and only the badge shows.
- **Bell:** a `Notification` row per recipient, with category `access`, title "Access request", body
  "<username> asked for access" and `reference_id` `access:<id>`. Rows go through the existing dedup
  and preference checks.
- **Push:** `dispatch_push(recipients, title, body, "access", "/settings#access-requests")`. The note
  is never put in a push.
- **`notifications.js`:** gets an icon (`person_add`), a link (`/settings#access-requests`) and a label
  ("Access requests") for the `access` category. The preferences list shows the `access` toggle to
  admins only.
- A notification failure never fails a submit. It is logged by request id.

## 9. Front end

### Sign-in card states

The card keeps its element, its size limit (`max-w-[440px]`), its frost and its logo. Only the region
under the logo changes. Each state is a block inside the card that is hidden until it is shown, so
nothing is built from strings of HTML; user text is set with `textContent`.

| State | Content | Ways out |
|---|---|---|
| S0 Sign in | Today's card, unchanged, plus one quiet text link under the buttons: "New here? Request access". The link is shown only when `auth_methods.request_access` is true | Link to S1 |
| S1 Intro | Heading "Request access". Two short lines: they sign in to Plex so we know who they are, and we read only their Plex username, email and picture. Button "Continue with Plex" | S2; "Back to sign in" to S0 |
| S2 Waiting | "Waiting for Plex..." and a "Reopen Plex sign-in" button, for when the popup was blocked or lost | S3 or S5 when identify answers; "Cancel" to S1 |
| S3 Form | "Requesting as <username>" with the avatar. Name field (`autocomplete="name"`). Textarea "Who are you and how do you know us?" with a 0/1000 counter. Button "Send request" | S4; "Back to sign in" to S0 |
| S4 Sent | "Request sent: watch your email for the Plex invite." | "Back to sign in" to S0 |
| S5 Status | One message per state (below) | "Back to sign in" to S0 |

S5 messages:

- `pending`: "Your request is waiting for review. Sent <date>."
- `approved` and `invited`: "You're approved. Accept the Plex invite from your email or a Plex app,
  then sign in here."
- `denied`: "This request wasn't approved. You can ask again after <date>."
- `blocked`: "This Plex account can't request access."
- `member`: "You already have access. Sign in." This message's button takes them to S0 and focuses
  the first sign-in button.

Behaviour:

- **Entering the flow** pushes one history entry (`#request-access`), so the browser's Back button
  returns to S0. Moving between steps doesn't add history entries.
- **Focus:** each new state moves focus to its heading (`tabindex="-1"`). One polite live region
  announces the step. Errors appear in a `role="alert"` line inside the card.
- **Desktop** uses a popup, like the existing Plex button. The message handler accepts only this
  origin and only the popup this page opened. If the popup closes without a message, the page calls
  identify once. "Not yet authorized" then goes back to S1 with "Plex sign-in was closed before it
  finished."
- **Phones** use a redirect. The page stores `access_pin_id` in `sessionStorage`. `plex-callback.js`
  sends a page whose own URL has `for=access` (that exact value only) back to
  `/login?access_request=complete` instead of `?plex_auth=complete`. The login page then opens the card
  in S2, calls identify, and clears the query with `history.replaceState`.
- **Feature off:** no link, and `?access_request=complete` is ignored.
- **Motion:** the content swap is a short fade. Under reduced motion it is instant. The card's height
  change follows the content and doesn't animate.
- **Width:** the card must work at 390 and 1440 wide, at the left, centre and right card positions.

### Admin: Settings > Access requests

A new tab, `access-requests`, after Sign-in. It has its own `app/static/js/settings/access-requests.js`
and follows the kit's patterns. The tab carries a pending count badge, which is hidden at 0 and whose
accessible name is "Access requests, 3 waiting". The panel, top to bottom:

1. **Switch:** "Let people request access from the sign-in page". When Plex isn't connected, a note
   says the switch needs it.
2. **Default libraries:** checkboxes from `/libraries`, saved to `access_requests.default_libraries`.
3. **Waiting:** one card per pending request, showing the avatar, Plex username, email, name, note
   (with line breaks kept, as text) and the time it was sent. Buttons Approve and Deny.
   - **Approve** opens the shared dialog (`ui.js`) with the library checkboxes, the default set already
     ticked. Confirm is "Share and approve".
   - When the share fails, the row shows Plex's reason and a "Share it in Plex yourself" button. The
     button copies the username to the clipboard and confirms with a toast.
   - **Deny** opens the dialog with a "Block this Plex account for good" checkbox.
4. **Decided:** the last 30 days of decisions, and blocked accounts with "Unblock".

## 10. Error handling

| Case | What the person sees |
|---|---|
| Feature off | No link. Every public route returns 403 "Access requests are closed." |
| Plex not configured | Same as feature off (the branding flag is false and the gate refuses) |
| Plex down when starting or identifying | Inline error "Plex isn't answering right now. Try again in a minute." The card stays on the same step |
| Popup blocked | S2 with "Your browser blocked the Plex window" and the Reopen button (opened from a click) |
| Popup closed early | Back to S1 with "Plex sign-in was closed before it finished." |
| PIN expired or binding wrong | "That Plex sign-in expired. Start again." Back to S1 |
| Already a member | S5 `member` |
| Already pending, approved or invited | S5 with that state; no new row |
| Cooldown or blocked | S5 `denied` or `blocked` |
| Cap of 20 reached | Inline error on S3: "We're not taking new requests right now. Try again later." The count is never shown |
| Ticket expired between identify and submit | "Your Plex check timed out. Start again." Back to S1 |
| Rate limited | "Too many tries. Wait a few minutes and try again." |
| Share fails on approve | The row is approved, with `share_state` `failed`, Plex's reason, and the copy-username button |

## 11. Security notes

- **No session, no token at rest.** The requester's Plex token lives only in local variables during
  identify. Tests (section 12) check that a sentinel token never reaches Redis, the database, logs or
  responses.
- **CSRF:** every POST requires the same origin (`require_same_origin`). The ticket cookie is
  SameSite=Strict and scoped to `/api/access-requests`. Admin writes are already same-origin and admin
  only.
- **PIN binding:** the same scheme as `plex_callback` (a nonce cookie, the hash in Redis, a single
  generic error, and an atomic claim), in its own namespace.
- **Enumeration:** identify reveals state only for the account that just proved itself through Plex.
  There is no lookup by username or email. The cap message hides the count.
- **Input:** length limits on every field; text is shown only with `textContent`; the avatar URL is
  allowlisted to `https` on `plex.tv` hosts (the CSP already allows `https:` images).
- **Abuse:** IP rate limits, one open request per account, and a cap of 20 pending requests. Someone
  with many Plex accounts could fill the 20 slots. The admin's remedy is deny and block. This is
  accepted.
- **Logging:** request id, Plex account id and outcome only. No note, email, token or cookie.
- **Admin token:** sent only to fixed plex.tv hosts, in a header. There are no user-supplied URLs, so
  there is no SSRF surface.
- **Audit scope:** the three public routes, the identify flow and the callback page's `for=access`
  branch go on the v2.0 audit list.

## 12. Testing

- **Python unit tests (`app/tests`):**
  - Gate: every route refuses when the feature is off or Plex isn't configured, and admin routes give
    403 to members and 401 to anonymous callers.
  - PIN binding: identical errors, the claim's 409, and separation of the request and sign-in
    namespaces.
  - Each identify state.
  - Ticket: one use, expiry, and that it can't be forged.
  - Submit: the cap under concurrent submits, and one open request per account.
  - Cooldown, block, unblock and the tidy job.
  - Input limits and same-origin refusals.
  - Token sentinel: never in Redis keys or values, the database, captured logs or responses.
  - Share client against an `httpx.MockTransport` with a catch-all that fails: `existing` (no POST),
    `shared` (POST plus a confirming listing), and `failed` (a 4xx or 5xx, and no confirming listing).
  - Notifications: recipients come from `admin_contacts` by the owner's Plex account id, never by
    comparing emails (an admin whose Authentik email differs from the plex.tv email is still reached,
    and an allowlist-only admin is not); dedup; and no note in the push.
- **happy-dom (`app/tests/js/login_request.mjs`, `settings_access.mjs`):**
  - Every card transition, focus on the heading, the live region text, the back links and the
    browser's Back.
  - Feature off hides the link.
  - The popup-blocked and popup-closed paths, the phone return path, and each S5 message.
  - The counter.
  - The admin tab: badge, approve dialog defaults, failed-share row and copy button, and the note
    rendered as text.
  - Both files are added to `package.json` `test:js` and the CI js-checks list.
- **Live checks on dev (ws-dev-browser):**
  - The card's states at 390 and 1440, in all three card positions, keyboard only, and the accessible
    names.
  - The admin tab with rows seeded by a new devkit command in the reserved `plex:9900xx` range,
    finished with `cleanup`.
  - No real share happens on dev except to the test Plex account Jordan provides, with Jordan present.

## 13. Open risks

1. **The Plex create call is unproven** (section 3). Task 1 proves it.
2. **Authentik account creation for newly shared users.** Authentik's Plex source must enroll a new
   user on their first sign-in, and its server check must pass once the invite is accepted (friends
   checking is off since the August 2026 friends retirement). Before the build, confirm this
   read-only in Authentik's admin UI or API: the Plex source's enrollment flow, user matching mode and
   allowed servers. Change nothing.
3. **Invite acceptance.** Until the person accepts the invite, both Authentik and WebServarr refuse
   them. The S4 and S5 wording covers this. Plex's own email is the only reminder.
4. **Plex friendship.** Plex Web asks whether a share should also add the person as a friend. Route A
   sends what python-plexapi sends. Task 1 records whether the test account ends up as a Plex friend,
   so Jordan can decide whether that matters.

## 14. Build order

1. **Plex proof**, with Jordan and a test Plex account he provides:
   - Run the read-only Authentik check (risk 2). The admin's notification address needs no check:
     section 8 finds the admin by Plex account id, not by email.
   - Share once from dev through route A, or B if A fails, and confirm it in `owned/pending`.
   - Jordan accepts the invite on the test account; confirm that WebServarr's gate and Authentik
     sign-in pass.
   - Jordan removes the share in Plex himself. The agent never sends DELETE.
2. Data model, settings keys, branding flag and tidy job, with tests.
3. Plex share client, with mocked tests.
4. Public routes (pin, identify, submit) and the `for=access` branch in `plex-callback.js`, with tests.
5. Admin routes and notifications, with tests.
6. **Mockup gate:** one static mockup in `docs/mockups/` showing every card state at 390 and 1440 and
   the admin tab. Jordan approves it before step 7.
7. The sign-in card front end, with happy-dom tests.
8. The Settings tab front end, with happy-dom tests.
9. Live dev checks and an end-to-end run with the test Plex account. Add the routes to the v2.0 audit
   scope list.
