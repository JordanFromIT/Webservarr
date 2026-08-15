# WebServarr Ebook Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A custom, fully themed ebook library and reader inside WebServarr, backed by Kavita on mediaserver, with per-user reading state living in Kavita.

**Architecture:** Kavita is the backend and owns the library plus all per-user state. WebServarr is the front-end and reverse-proxies Kavita over WireGuard, so the browser only ever talks to `hmserver.tv`. Users are shared via Authentik OIDC. WebServarr stores no ebook data.

**Tech Stack:** FastAPI, httpx (streaming), slowapi, Redis sessions, vanilla JS, Tailwind via CDN, Kavita 0.9.0.2.

**Spec:** `docs/superpowers/specs/2026-08-14-webservarr-ebook-reader-design.md`

## Global Constraints

- **Branch:** `dev-ebook-reader` (exists, off `main` at `ddc4c59`).
- **Never build Docker images from source.** commit → push → tag → GHCR → watchtower deploys.
- **Every pushed commit carries a semver tag.** This release is **v1.5.0** (latest is `v1.4.2`). Do not push a `v*` tag until Task 7 — tagging triggers the build *and* auto-deploys to production.
- **Claude is never a git contributor.** No `Co-Authored-By`, never as author or committer.
- **Kavita is LAN-only.** No public hostname, no tunnel route. Reachable only from the VPS at `http://10.10.0.3:5000` over WireGuard.
- **Kavita's `baseUrl` stays `/`.** We serve none of its Angular app, only its API.
- **No new database tables.** All per-user state lives in Kavita.
- **The reader renders Kavita's server-paginated HTML** (`book/{chapterId}/book-page?page=N`). Never a client-side EPUB parser — progress and annotations anchor to Kavita's page numbers.
- **No hardcoded brand hex values.** Both pages use `theme-loader.js` and the Tailwind alias block from `index.html:16–25`.
- **Every proxy route requires `Depends(get_current_user)`.** The proxy must never become an open relay into the LAN.

### Already done and proven (2026-08-14, tested live — not assumed)

**Infrastructure**

- Kavita 0.9.0.2 running at `/mnt/disks/1tbnvme/containers/kavita`, library mounted **read-only**, 107 files → 93 series
- Authentik application + provider `Kavita` — confidential, implicit consent (no prompt), PKCE S256, `sub_mode` hashed user ID, scopes `openid profile email`
- Redirect URIs: `https://hmserver.tv/signin-oidc` and `https://dev.hmserver.tv/signin-oidc`
- Silent SSO and auto-provisioning proven end to end
- Public subdomain removed; VPS-only access confirmed
- JWT signing key rotated (it was exposed during investigation)
- Dev instance on the VPS: container `webservarr-dev`, `127.0.0.1:7980`, tunnelled at
  `dev.hmserver.tv`, own data dir, production settings copied. Runs the GHCR image with
  `/root/webservarr-dev/app` mounted over `/app/app`, so `rsync` + `docker restart` is the
  edit-test loop without ever building from source or tagging a release.

**Two configuration fixes without which every user sees an empty library**

Both were found by testing, and both fail *silently* — the user logs in fine and the library
is simply blank.

1. **Authentik must send `email_verified: true`.** Its default email mapping hardcodes
   `email_verified: False`, and Kavita's `NewUserFromOpenIdConnect` only calls
   `ConfirmEmailAsync` when `claimsPrincipal.HasVerifiedEmail()` — so users are created
   *pending* and see nothing. Fixed with a Kavita-specific scope mapping
   ("Kavita OpenID email (verified)") attached to that provider only; the shared default is
   untouched, so WebServarr and Counselor keep their existing behaviour.
   Note `requireVerifiedEmail: false` does **not** help — it only governs whether Kavita
   rejects unverified emails, not whether it confirms them.

2. **Kavita's OIDC defaults must not age-restrict new users.** `defaultAgeRestriction: 0`
   means "Unknown", and with `defaultIncludeUnknowns: false` a user restricted to Unknown
   while excluding unknowns matches nothing — these books carry no age rating at all. Set to
   `defaultAgeRestriction: -1` (no restriction, matching admin) and
   `defaultIncludeUnknowns: true`.

Verified after both fixes: a freshly provisioned user is `pending=False`, holds
`ageRestriction {ageRating: -1, includeUnknowns: true}`, and sees all **93 series**.

**Reader mechanics — every v1.5.0 dependency verified by direct API call**

| Capability | Call | Result |
|---|---|---|
| Page rendering | `GET /api/Book/23/book-page?page=1` | 200, 10 KB of HTML |
| Progress write | `POST /api/Reader/progress` `{libraryId,seriesId,volumeId,chapterId,pageNum:7}` | 200 |
| Progress read | `GET /api/Reader/get-progress?chapterId=23` | `pageNum: 7` ✓ round-trips |
| Bookmarks | `POST /api/Reader/bookmark` | 200 |
| Per-user isolation | `get-progress` takes **only** `chapterId` | user derived from the JWT — isolation is structural, not something we can implement wrongly |

Two facts from that testing shape the implementation:

1. **Kavita namespaces book CSS under `.book-content`**, so the book's own styles cannot leak into the surrounding page. Our chrome is safe to style freely.
2. **`bookScrollId`** exists alongside `pageNum` in the progress payload — within-page scroll position, which the reader should also persist.

**Annotations (v1.6.0) — payload proven, HTTP 200, stored and read back.** The DTO is
`Kavita.Models/DTOs/Reader/AnnotationDto.cs`. Two traps: the slot field is
**`selectedSlotIndex`** (not `slotNumber`), and several fields are non-nullable C# strings that
throw inside the service if omitted — `endingXPath`, `selectedText`, `likes`, `seriesName`,
`libraryName`, `ownerUsername`. Working payload:

```json
{
  "xPath": "id(\"_idContainer001\")",
  "endingXPath": "id(\"_idContainer001\")",
  "selectedText": "the Emperor protects",
  "comment": "note", "commentHtml": "<p>note</p>", "commentPlainText": "note",
  "chapterTitle": null, "context": null,
  "highlightCount": 20, "containsSpoiler": false,
  "pageNumber": 7, "selectedSlotIndex": 0, "likes": [],
  "seriesName": "13th Legion", "libraryName": "eBooks",
  "chapterId": 23, "volumeId": 22, "seriesId": 22, "libraryId": 1,
  "ownerUserId": 1, "ownerUsername": "admin"
}
```

`chapterTitle` is resolved server-side from the xPath — Kavita returned `"Introduction"`.
`selectedSlotIndex` is 0–4, matching the five highlight colour slots on the user's account.

**Consequence for Task 6 — the `.book-content` wrapper is mandatory.** Verified by reading
Kavita's `readerService`:

```js
getXPath(e)  { if (!t && e.id) return `id("${e.id}")`; ... }   // ids are position-independent
descopeBookReaderXpath(e) {
    if (e.startsWith("id(")) return e;
    const t = document.querySelector(".book-content");
    return this.extractContentPath(normalize(e), normalize(getXPathTo(t.children[0], true)));
}
```

Kavita **descopes xPaths relative to `.book-content`** on save and re-scopes on load. Therefore:

- ✅ The reader may wrap `.book-content` in any number of its own containers — everything above it is stripped
- ✅ All styling, chrome, layout and navigation are unconstrained
- ✅ Elements carrying an `id` (Kavita's book HTML uses `_idContainer001`-style ids) anchor via `id("...")` and are immune to position entirely
- ❌ The DOM **inside** `.book-content` must not be restructured, re-wrapped or sanitised

**Requirement:** insert the HTML returned by `book-page` into an element with
`class="book-content"`. That single wrapper satisfies both Kavita's scoped CSS (its `<style>`
blocks are written as `.book-content div { ... }`) and xPath descoping.

---

## Task 1: Harden the Kavita instance

**Files:** none in the repo.

- [ ] **Step 1: Rotate the JWT signing key**

It was exposed during investigation. Rotating now is free — no real users exist yet.

```bash
ssh mediaserver "docker exec kavita sh -c 'head -c 48 /dev/urandom | base64 -w0'"
```

Edit `TokenKey` in `/mnt/disks/1tbnvme/containers/kavita/config/appsettings.json` to that value, then:

```bash
ssh mediaserver "cd /mnt/disks/1tbnvme/containers/kavita && docker compose restart && sleep 25 && curl -s -o /dev/null -w 'kavita: %{http_code}\n' http://localhost:5000/"
```

- [ ] **Step 2: Confirm the admin can still log in**

```bash
ssh mediaserver "curl -s -X POST http://localhost:5000/api/Account/login -H 'Content-Type: application/json' -d '{\"username\":\"admin\",\"password\":\"<password>\"}' -o /dev/null -w 'login: %{http_code}\n'"
```

Expected 200. Existing sessions are invalidated by the rotation, which is fine.

- [ ] **Step 3: Confirm OIDC survived the restart**

```bash
ssh mediaserver "curl -s -o /dev/null -D - http://localhost:5000/oidc/login | grep -i location | head -1"
```

Expected: a 302 to `auth.hmserver.tv` carrying `client_id` and PKCE.

**No commit.**

---

## Task 2: Library data preparation

Two independent data problems, both outside the repo.

- [ ] **Step 1: Audit embedded EPUB metadata (read-only)**

```bash
ssh mediaserver "cat > /tmp/audit.py <<'EOF'
import glob, zipfile, re
from xml.etree import ElementTree as ET
NS={'dc':'http://purl.org/dc/elements/1.1/'}
ok, bad = 0, []
for p in glob.glob('/mnt/mediapool/library/eBooks/**/*.epub', recursive=True):
    try:
        z=zipfile.ZipFile(p)
        opf=next((n for n in z.namelist() if n.endswith('.opf')), None)
        if not opf: bad.append((p,'no OPF')); continue
        r=ET.fromstring(z.read(opf))
        t=(r.findtext('.//dc:title',namespaces=NS) or '').strip()
        a=(r.findtext('.//dc:creator',namespaces=NS) or '').strip()
        if not t or not a: bad.append((p,f'title={t!r} author={a!r}'))
        elif re.search(r'(calibre|unknown|www\.|\.com|retail)', t+a, re.I): bad.append((p,f'suspect {t!r}/{a!r}'))
        else: ok+=1
    except Exception as e: bad.append((p,f'error {e}'))
tot=ok+len(bad)
print(f'clean {ok}/{tot}  suspect {len(bad)}/{tot} = {100*len(bad)/tot:.1f}%')
for p,w in bad: print('  -',w,'<-',p.split('/')[-1])
EOF
python3 /tmp/audit.py"
```

**Decision rule:** under ~10% suspect → fix those by hand in Kavita, build no pipeline, continue. At or above ~10% → stop and report the number; a metadata pipeline becomes its own scoped work.

Record the actual number in this file.

- [ ] **Step 2: Back up the 16 MOBI/AZW3 originals**

```bash
ssh mediaserver "mkdir -p /mnt/mediapool/backup/ebook-originals-20260814 && \
  find /mnt/mediapool/library/eBooks -type f \( -name '*.mobi' -o -name '*.azw3' \) \
    -exec cp -v --parents {} /mnt/mediapool/backup/ebook-originals-20260814/ \; ; \
  find /mnt/mediapool/backup/ebook-originals-20260814 -type f | wc -l"
```

Expected `16`. **If not 16, stop** — the backup is the rollback.

- [ ] **Step 3: Convert in staging, outside the library root**

```bash
ssh mediaserver "mkdir -p /tmp/ebook-convert && \
  docker run --rm -v /mnt/mediapool/library/eBooks:/in:ro -v /tmp/ebook-convert:/out \
    linuxserver/calibre:latest /bin/bash -c '
      find /in -type f \( -name \"*.mobi\" -o -name \"*.azw3\" \) | while read f; do
        b=\$(basename \"\${f%.*}\")
        ebook-convert \"\$f\" \"/out/\${b}.epub\" >/dev/null 2>&1 && echo \"OK   \$b\" || echo \"FAIL \$b\"
      done'"
```

Record every `FAIL`. Failures are reported, never silently skipped.

- [ ] **Step 4: Validate each output opens and has a title**

```bash
ssh mediaserver "cd /tmp/ebook-convert && for f in *.epub; do python3 -c \"
import zipfile
from xml.etree import ElementTree as ET
p='\$f'
try:
    z=zipfile.ZipFile(p); o=next(n for n in z.namelist() if n.endswith('.opf'))
    t=ET.fromstring(z.read(o)).findtext('.//{http://purl.org/dc/elements/1.1/}title')
    print('OK  ',p,'-',(t or '').strip()[:50])
except Exception as e: print('BAD ',p,e)
\"; done"
```

Anything reporting `BAD` is not placed.

- [ ] **Step 5: Place validated EPUBs beside their originals, then rescan**

```bash
ssh mediaserver "find /mnt/mediapool/library/eBooks -type f \( -name '*.mobi' -o -name '*.azw3' \) | while read f; do
    d=\$(dirname \"\$f\"); b=\$(basename \"\${f%.*}\")
    [ -f \"/tmp/ebook-convert/\${b}.epub\" ] && cp -v \"/tmp/ebook-convert/\${b}.epub\" \"\$d/\${b}.epub\"
  done"
```

Then force a Kavita scan and confirm the series count rises by the number placed. Originals are never modified; rollback is deleting the added `.epub` files.

- [ ] **Step 6: Note the broken book**

`Michael Crichton/Travels/Travels.epub` cannot be parsed by Kavita at all. It needs re-acquiring through Chaptarr — record it and move on; it does not block this work.

**No commit.**

---

## Task 3: Kavita proxy foundation

The core of the whole feature.

**Files:**
- Create: `app/routers/kavita_proxy.py`
- Modify: `app/main.py`, `app/routers/admin.py`

**Interfaces:**
- Produces: `GET/POST /kavita/{path:path}` forwarding to Kavita with the caller's Kavita JWT attached, and `_kavita_base()` returning the configured URL. Tasks 4–6 depend on it.

- [ ] **Step 1: Add the settings**

`integration.kavita.url` = `http://10.10.0.3:5000`. The key matches `_INTEGRATION_URL_KEY` in `app/routers/admin.py`, so `_check_setting_write` validates it via `is_safe_integration_url`, which permits LAN and blocks loopback/link-local/metadata. No new security code.

- [ ] **Step 2: Write the proxy**

```python
"""
Kavita reverse proxy.

Kavita is LAN-only and emits no CORS headers, so the browser can never call it
directly. Every request goes through here: same origin for the browser, plain
HTTP server-side over WireGuard — the same pattern used for Plex, Seerr,
Netdata, Sonarr, Radarr and Uptime Kuma.
"""

import logging
from typing import Dict
import httpx
from fastapi import APIRouter, Depends, Request, Response, HTTPException
from fastapi.responses import StreamingResponse
from app.dependencies import get_current_user
from app.limiter import limiter
from app.database import SessionLocal
from app.models import Setting

logger = logging.getLogger(__name__)
router = APIRouter()

TIMEOUT = 15.0
STREAM_TIMEOUT = 60.0
# Hop-by-hop headers must not be forwarded.
_STRIP = {"host", "connection", "keep-alive", "transfer-encoding", "upgrade",
          "proxy-authorization", "proxy-authenticate", "te", "trailers"}


def _kavita_base() -> str | None:
    db = SessionLocal()
    try:
        row = db.query(Setting).filter(Setting.key == "integration.kavita.url").first()
        return row.value.rstrip("/") if row and row.value else None
    finally:
        db.close()


@router.api_route("/kavita/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
@limiter.limit("240/minute")
async def kavita_proxy(
    path: str,
    request: Request,
    current_user: Dict[str, str] = Depends(get_current_user),
):
    """Forward /kavita/<path> to Kavita, attaching this user's Kavita JWT."""
    base = _kavita_base()
    if not base:
        raise HTTPException(status_code=503, detail="Kavita is not configured")

    token = current_user.get("kavita_token")

    headers = {k: v for k, v in request.headers.items() if k.lower() not in _STRIP}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    body = await request.body()
    url = f"{base}/{path}"

    client = httpx.AsyncClient(timeout=STREAM_TIMEOUT)
    req = client.build_request(
        request.method, url, headers=headers, content=body,
        params=dict(request.query_params),
    )
    upstream = await client.send(req, stream=True)

    if upstream.status_code == 401:
        await upstream.aclose(); await client.aclose()
        # Session's Kavita token is stale — the frontend re-runs the handshake.
        raise HTTPException(status_code=401, detail="Kavita session expired")

    async def _body():
        try:
            async for chunk in upstream.aiter_bytes(65536):
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    passthrough = {
        k: v for k, v in upstream.headers.items()
        if k.lower() in {"content-type", "content-length", "cache-control", "etag", "last-modified"}
    }
    return StreamingResponse(_body(), status_code=upstream.status_code, headers=passthrough)
```

Streaming matters: book pages and cover images must not be buffered into memory per request.

- [ ] **Step 3: Register in `app/main.py`**

Add alongside the existing registrations (after `tickets`, ~line 227). Note **no `/api` prefix** — this router owns `/kavita/*` at root:

```python
app.include_router(kavita_proxy.router, tags=["Kavita"])
```

- [ ] **Step 4: Verify auth gating and forwarding**

```bash
# Unauthenticated MUST be 401 - this is the open-relay guard
curl -s -o /dev/null -w "no-auth: %{http_code}\n" http://localhost:8000/kavita/api/Library/libraries

# Authenticated reaches Kavita (401 from Kavita until Task 4 supplies a token)
curl -s -c /tmp/c.txt -X POST http://localhost:8000/auth/simple-login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' -o /dev/null
curl -s -b /tmp/c.txt -o /dev/null -w "authed: %{http_code}\n" http://localhost:8000/kavita/api/Library/libraries
```

Expected: `no-auth: 401`. The authenticated call reaching Kavita at all proves the forward works.

- [ ] **Step 5: Commit**

```bash
git add app/routers/kavita_proxy.py app/main.py app/routers/admin.py
git commit -m "feat: add Kavita reverse proxy with per-user token forwarding"
```

---

## Task 4: OIDC handoff

Gets each user a Kavita JWT without them noticing.

**Files:** Modify `app/routers/kavita_proxy.py`

**Interfaces:**
- Produces: `GET /kavita/connect` (starts the handshake) and `GET|POST /signin-oidc` (completes it, stores the token in the Redis session as `kavita_token`).

- [ ] **Step 1: Understand the flow before writing code**

1. Browser hits `/kavita/connect`; WebServarr proxies Kavita's `/oidc/login`.
2. Kavita 302s to Authentik with PKCE. Authentik sees the user's existing session and returns immediately — no prompt, no consent (verified 2026-08-14).
3. Authentik POSTs back to `/signin-oidc` (`response_mode=form_post`).
4. WebServarr proxies that POST to Kavita, which creates the account on first visit and establishes its session.
5. WebServarr calls Kavita's `/api/account/oidc-authenticated` using the cookies Kavita just set, retrieves the JWT, stores it in the user's Redis session, and redirects the browser to `/library`.

**The cookies — measured, not guessed.** On `/oidc/login` Kavita sets exactly two:

```
Set-Cookie: .AspNetCore.OpenIdConnect.Nonce.<id>=...; path=/signin-oidc; secure; samesite=none; httponly
Set-Cookie: .AspNetCore.Correlation.<id>=...;         path=/signin-oidc; secure; samesite=none; httponly
```

Three consequences, all now known rather than discovered mid-build:

1. **`path=/signin-oidc` is why the callback must live at WebServarr's root.** The browser only sends these cookies to that exact path. Proxying the callback at `/kavita/signin-oidc` would silently drop them and the handshake would fail.
2. **`samesite=none; secure` is already satisfied** — Authentik POSTs back cross-site, and `hmserver.tv` is HTTPS.
3. The relay is therefore narrow and specific: pass `Set-Cookie` through on `/kavita/connect`, and pass the browser's `Cookie` header through on `/signin-oidc`. Nothing else needs cookie handling.

Verified failure mode for reference: hitting `/signin-oidc` without state returns
`?error=OpenIdConnectAuthenticationHandler: message.State is null or empty` — that is what a
broken relay looks like.

- [ ] **Step 2: Add `update_session` to `SessionManager` — it does not exist yet**

`app/auth.py` has `create_session`, `get_session`, `delete_session` and the state helpers, but no way to merge a field into a live session. Sessions are stored as a Redis hash (`hset` with a mapping, read back with `hgetall`), so adding a field is straightforward and `get_session` will return it automatically — meaning `current_user.get("kavita_token")` in the proxy works with no other change.

Add to `SessionManager` in `app/auth.py`:

```python
    async def update_session(self, session_id: str, fields: Dict[str, Any]) -> None:
        """
        Merge fields into an existing session hash.

        Used to attach the user's Kavita JWT after the OIDC handoff. No-ops if
        the session has expired, so a stale callback cannot resurrect one.
        """
        redis = await self.get_redis()
        session_key = f"session:{session_id}"

        if not await redis.exists(session_key):
            return

        await redis.hset(session_key, mapping={k: str(v) for k, v in fields.items()})
        await redis.expire(session_key, self.max_age)
```

- [ ] **Step 3: Implement the handshake, relaying cookies**

Add `set-cookie` to the passthrough headers for `/kavita/connect` and `/signin-oidc` **only** — not for general API proxying. Follow the redirect chain manually rather than letting httpx auto-follow, so the `Location` header can be rewritten to a WebServarr-relative path.

After a successful callback, retrieve and store the token:

```python
# Kavita's SPA fetches its JWT from this endpoint after the callback.
info = await client.get(f"{base}/api/account/oidc-authenticated",
                        headers={"Cookie": kavita_cookies})
token = info.json().get("token")
await session_manager.update_session(session_id, {"kavita_token": token})
```

- [ ] **Step 4: Verify with a real browser**

Using Chrome DevTools MCP, logged into hmserver.tv:

```
navigate to https://hmserver.tv/kavita/connect
```

Expected: it returns to WebServarr authenticated, with **no Authentik prompt and no consent screen**.

Then confirm the session carries the token and API calls now succeed:

```bash
curl -s -b <session cookie> http://localhost:8000/kavita/api/Library/libraries
```

Expected: the eBooks library, HTTP 200.

- [ ] **Step 5: Verify the cold-start guard**

An unauthenticated visitor must be redirected to WebServarr's login, **never** into Kavita's handshake — Authentik's default flow shows a username/password box with no Plex option, which is a dead end for your users.

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:8000/kavita/connect
```

Expected: 401 or a redirect to `/login`.

- [ ] **Step 6: Commit**

```bash
git add app/routers/kavita_proxy.py
git commit -m "feat: silent Kavita OIDC handoff via Authentik"
```

---

## Task 5: Library page

**Files:** Create `app/static/library.html`; modify `app/routers/branding.py`

- [ ] **Step 1: Wire the theming engine first**

⚠️ **Do not hardcode brand hexes.** In `<head>`, before the Tailwind CDN script:

```html
<script src="/static/js/theme-loader.js"></script>
```

Then replicate the Tailwind alias block exactly as `index.html:16–25` declares it:

```js
"primary":          "rgb(var(--color-primary) / <alpha-value>)",
"baltic-blue":      "rgb(var(--color-primary) / <alpha-value>)",
"cornflower-ocean": "rgb(var(--color-secondary) / <alpha-value>)",
"steel-blue":       "rgb(var(--color-accent) / <alpha-value>)",
"frosted-blue":     "rgb(var(--color-text) / <alpha-value>)",
"bright":           "rgb(var(--color-text-secondary) / <alpha-value>)",
"background-dark":  "rgb(var(--color-background) / <alpha-value>)",
```

with `"display": ["var(--font-display)", "sans-serif"]`. Use `--hex-*` only where a raw colour is unavoidable.

- [ ] **Step 2: Add the `show_books` feature flag**

In `app/routers/branding.py`, alongside `show_requests` / `show_tickets`, defaulting to whether `integration.kavita.url` is configured.

- [ ] **Step 3: Build the page**

Auth check on load, redirect to `/login` on 401. Then:

- **Continue reading** row from `/kavita/api/series/on-deck`, hidden when empty
- **Cover grid** from `POST /kavita/api/Series/all-v2?pageNumber=&pageSize=` with body `{"statements":[],"combination":0,"limitTo":0}`; covers via `/kavita/api/image/series-cover?seriesId=`
- **Search** via `/kavita/api/search/...`
- **Paged navigation** — never load the whole library
- **Explicit unavailable state** when Kavita is down. Not a spinner.

On a 401 from any `/kavita/*` call, transparently re-run `/kavita/connect` once, then retry — that is how an expired Kavita token self-heals without the user seeing anything.

- [ ] **Step 4: Add the sidebar entry**

Follow the existing `sidebar_labels` / `icons` pattern. Defaults: label `Library`, icon `menu_book`.

- [ ] **Step 5: Verify, including theming**

Via Chrome DevTools MCP: covers render, search works, pagination advances, no console errors. Stop Kavita (`ssh mediaserver "docker stop kavita"`) and confirm a clear unavailable state; restart after.

Then the theming check a visual inspection cannot catch — the defaults look right precisely because they match the brand palette:

```js
document.documentElement.style.setProperty('--color-primary', '255 0 128');
```

Everything themed turns hot pink. Anything still blue has a hardcoded hex and must be converted.

- [ ] **Step 6: Commit**

```bash
git add app/static/library.html app/routers/branding.py
git commit -m "feat: add ebook library browse page"
```

---

## Task 6: Reader page

**Files:** Create `app/static/reader.html`; modify `app/main.py` if CSP requires it

- [ ] **Step 1: Fetch and render Kavita's page HTML**

```
GET /kavita/api/book/{chapterId}/book-info          -> title, page count
GET /kavita/api/book/{chapterId}/book-page?page=N   -> rendered HTML for page N
GET /kavita/api/reader/chapter-info?chapterId=       -> chapter metadata
```

Insert the returned HTML into a container **we** style. Kavita supplies structure; every visual decision is ours.

⚠️ Book HTML may reference internal resources. If any request is blocked by CSP, make a **narrow** addition scoped to the reader — never relax `script-src`, never add a wildcard.

- [ ] **Step 2: Theming — two surfaces, handled differently**

*Page chrome* (toolbar, controls, background) uses the theming engine exactly as Task 5 step 1.

*Book content* is Kavita's HTML inside our container. Style it from `--hex-background` and `--hex-text` so it opens matching the site, then let the reader's own light/dark/sepia control override — readers legitimately want sepia regardless of site branding.

- [ ] **Step 3: Reader controls**

Font family, size, line height, margins, justification; light/dark/sepia; single or double column; scroll or paginated within a page; fullscreen. Persist preferences to Kavita via the user's account preferences so they follow the user across devices.

- [ ] **Step 4: Navigation**

Table of contents (`reader/create-ptoc`), progress indicator with page position, next/previous page and chapter, keyboard shortcuts (arrows, space, `j`/`k`), and mobile tap zones. Phone is expected to be the dominant reading mode.

- [ ] **Step 5: Progress and bookmarks**

Save progress on page change, debounced to at most one write every 5 seconds, plus a final write on `visibilitychange` and `pagehide`:

```
POST /kavita/api/reader/progress   { libraryId, seriesId, volumeId, chapterId, pageNum }
GET  /kavita/api/reader/get-progress?chapterId=
POST /kavita/api/reader/bookmark
```

**A failed progress write must never interrupt reading.** Catch, keep rendering, retry on the next tick.

- [ ] **Step 6: Verify**

Via Chrome DevTools MCP: a book opens and renders; page turns work; position persists across reload; no CSP violations; mobile viewport usable; theme override moves the chrome.

The interop question this step used to gamble on — whether progress written through the API is real, per-user Kavita state — was **already settled before any code was written** (see "Already done and proven"): `POST /api/Reader/progress` returns 200 and `get-progress` round-trips `pageNum: 7`, with the user derived from the JWT rather than a parameter. This step confirms the reader wires those proven calls correctly; it is no longer where the architecture is validated.

- [ ] **Step 7: Commit**

```bash
git add app/static/reader.html app/main.py
git commit -m "feat: add custom themed ebook reader over Kavita"
```

---

## Task 7: Release v1.5.0

- [ ] **Step 1: Pre-push review**

```bash
git log --oneline main..dev-ebook-reader
git log main..dev-ebook-reader --format='%an <%ae>' | grep -i "claude\|anthropic" && echo "PROBLEM" || echo "clean"
```

- [ ] **Step 2: Merge**

```bash
git checkout main && git merge --no-ff dev-ebook-reader -m "feat: ebook reader with Kavita backend"
```

- [ ] **Step 3: Tag and push**

⚠️ The tag triggers the GHCR build **and** watchtower's auto-deploy. Everything must be verified first.

```bash
git tag --sort=-v:refname | head -1      # confirm v1.4.2
git push && git tag v1.5.0 && git push --tags
gh run watch --exit-status
```

- [ ] **Step 4: Deploy and verify**

```bash
ssh webserver "cd ~/webservarr && docker compose pull && docker compose up -d"
sleep 20 && ssh webserver "curl -s localhost:7979/health"
```

Expected `1.5.0`. Then in production: the library loads, a book opens, position persists, existing integrations still 200, and the login page still behaves as v1.4.2 fixed it (no simple-auth flash on cold load).

- [ ] **Step 5: Update the phase table**

Add Phase 15 "Ebook Reader — Complete" to the parent `CLAUDE.md`.

- [ ] **Step 6: Final cleanup**

Tear down everything that existed only to build this:

1. **Revoke the Authentik API token.** Directory → Tokens & App passwords → delete the token
   issued for this work. It was deliberately kept alive across the build; it must not outlive it.
2. **Remove the dev instance** once the release is verified in production:
   ```bash
   ssh webserver "docker rm -f webservarr-dev && rm -rf /root/webservarr-dev"
   ```
   Then delete the `dev.hmserver.tv` tunnel route in Cloudflare.
3. **Drop the dev redirect URIs** from both Authentik providers, leaving only the production
   ones: `https://hmserver.tv/signin-oidc` (Kavita) and `https://hmserver.tv/auth/callback`
   (WebServarr).
4. **Delete the throwaway Kavita test data** — the annotation and reading progress created
   against *13th Legion* during API verification, and any test users beyond the real ones.
5. **Remove the staging conversion directory** on mediaserver: `/tmp/ebook-convert`. Keep
   `/mnt/mediapool/backup/ebook-originals-20260814` until you are satisfied the converted
   EPUBs are good.

Leave in place: the rotated Kavita signing key, the `email_verified` scope mapping, and the
Kavita OIDC age-restriction defaults — those are production configuration, not scaffolding.

---

## Roadmap after v1.5.0

Requested by Jordan 2026-08-15, each verified feasible against the live APIs before being
written down.

### v1.6.0 — Annotations
`annotation/create|update|bulk-delete|all-for-series|export`, multi-colour highlights (Kavita
ships 5 slots), notes, panel, Obsidian export. Payload proven; see the DTO above.

### v1.7.0 — Discovery shelves ("trending" / "top rated")
Plex-homescreen-style rows on the library page. Every endpoint exists and needs no new storage:

| Row | Endpoint |
|---|---|
| Continue reading | `series/on-deck` *(already shipped in v1.5.0)* |
| Recently added | `series/recently-added-v2` |
| Top rated | `rating/series`, `review/series`, `review/all` |
| Popular | `stats/popular-series` |
| Browse by genre / decade / tag | `stats/popular-genres`, `popular-decades`, `popular-tags` |

⚠️ **Expectation to set:** "trending" is derived from *your* users' activity. With a handful of
readers and a fresh install these rows will be sparse or empty at first — unlike Plex, which
blends in global data. Recently-added and top-rated will look meaningful long before popular
does.

### v1.8.0 — Audiobook availability badge
Show on a book that the audiobook also exists in Plex.

Verified: Plex library **key 6, type `artist`, titled "Audiobooks"**, 20 albums, queried via
`/library/sections/6/albums?X-Plex-Token=…`. Metadata is clean — album `title` is the book,
`parentTitle` is the author. WebServarr already holds `integration.plex.url` and
`integration.plex.token`, so no new integration is needed.

Real overlap confirmed: *The Andromeda Strain* is both a Kavita ebook and a Plex audiobook.

Matching is the actual work, and it is fuzzy. Observed complications:
- HTML entities in titles (`Harry Potter and the Sorcerer&#8217;s Stone`)
- Narrator appended to the title (`The Andromeda Evolution - Julia Whelan`,
  `Alpha Legion (German edition) - Tom Jacobs`)

So normalise before comparing: decode entities, strip a trailing `- Narrator` segment,
casefold, drop punctuation, then match on title **and** author. Cache the mapping rather than
querying Plex per card. Deep-link the badge to the Plex item.

### v1.9.0 — Book requests on the Requests page
Extend the existing Requests page to search and request ebooks/audiobooks alongside
movies and TV.

**Not blocked — the default metadata provider is, but a working one exists.**

An earlier note in this plan called this blocked. That was wrong: only Chaptarr's *default*
provider was tested.

```
GET /api/v1/search?term=dune                      → 503 {"message":"Hardcover search failed"}
GET /api/v1/search?term=dune&provider=goodreads   → 200, 7 results
```

`provider=googlebooks|google|openlibrary|bookinfo|isbndb` all return 200 with an empty array,
so **`goodreads` is the only provider that returns data** and must be passed explicitly.

Verified result shape — a single list mixing authors and books:

```json
{"foreignId": "hc:1095145", "providerId": "hc:1095145", "author": {"authorName": "Frank Herbert"}}
{"foreignId": "gr:3634639", "book": {"title": "Dune (Dune, #1)"}}
```

Authors carry `hc:` ids, books carry `gr:`. The request UI should split them: books are
directly requestable, authors are a drill-down.

⚠️ Still treat it as best-effort. The failing default shows this metadata path is fragile, and
Chaptarr is beta. **Degrade gracefully** — when book search errors, the Requests page must keep
working for movies and TV, which have nothing to do with Chaptarr.
- **Native apps and offline.** Re-add a tunnel route to Kavita and Kover/Inkita/KOReader work, with KOReader two-way position sync. **Zero WebServarr changes** — the proxy is unaffected. *Trigger: when offline reading becomes a requirement.*
- **Metadata pipeline.** Only if Task 2 step 1 reports ≥10% suspect.
- **Automated tests.** No suite exists; the per-user isolation and Kavita-interop checks are the natural first regression tests.
