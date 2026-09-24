"""
Kavita reverse proxy.

Kavita is the ebook backend. It runs on mediaserver, is reachable only across
the WireGuard tunnel, and emits no CORS headers — so the browser can never call
it directly. Every request is proxied through here: same-origin for the browser,
plain HTTP server-side over the tunnel.

This is the same proxy pattern already used for Plex, Seerr, Netdata, Sonarr,
Radarr and Uptime Kuma. The browser only ever loads the site's own HTTPS
origin, so there is no mixed-content problem.

Kavita owns all per-user reading state (progress, bookmarks, highlights,
shelves). WebServarr stores none of it — it forwards the caller's Kavita JWT,
which is obtained by the OIDC handoff and kept in their Redis session.
"""

import logging
import re
from typing import Dict, Optional
from urllib.parse import parse_qsl, urlencode, urlparse

import bleach
import httpx
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse, StreamingResponse

from app.auth import session_manager
from app.config import settings
from app.database import SessionLocal
from app.dependencies import get_current_user
from app.limiter import limiter
from app.models import Setting
from app.settings_registry import switch_is_off

logger = logging.getLogger(__name__)

router = APIRouter()

# Book pages and cover images are the bulk of traffic; allow a generous ceiling.
PROXY_TIMEOUT = 60.0

# Rendered book pages need their embedded Kavita URLs rewritten (see
# rewrite_book_html), so they are buffered rather than streamed.
_BOOK_PAGE_PATH = re.compile(r"^api/[Bb]ook/\d+/book-page$", re.IGNORECASE)

# Hop-by-hop headers must never be forwarded (RFC 9110 7.6.1).
#
# "accept-encoding" is stripped deliberately, not because it is hop-by-hop:
# browsers advertise br/zstd, Kavita honours brotli, and httpx cannot decode it
# without the optional brotli package. The compressed bytes would then be
# relayed while Content-Encoding is dropped, so the browser would render
# garbage. Asking upstream for identity keeps the proxy correct. The hop to
# Kavita is a ~23ms LAN link over WireGuard, so compression buys little here.
# "cookie" is stripped for a different reason again: the browser's cookie header
# for this origin carries the WebServarr *session id*, and forwarding it would
# disclose a live session credential to Kavita on every single proxied request -
# for nothing, since the catch-all authenticates with a Bearer token. It cannot
# be carrying anything Kavita wants either: set-cookie is filtered out of every
# proxied response, so the browser never holds a Kavita cookie to send back. The
# OIDC handshake routes build their own headers and set Cookie explicitly, so
# they are unaffected by this.
_HOP_BY_HOP = {
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
    "te",
    "trailers",
    "content-length",
    "accept-encoding",
    "cookie",
}

# Only these response headers are passed back to the browser. Notably absent:
# set-cookie, which must not leak Kavita's session cookies into general API
# traffic. The OIDC handoff relays those explicitly on its own routes.
_PASSTHROUGH_RESPONSE_HEADERS = {
    "content-type",
    "cache-control",
    "etag",
    "last-modified",
    "content-disposition",
    # Kavita returns paging totals here; without it the library page cannot
    # tell how many pages exist.
    "x-pagination",
}

# The only Kavita API resources the reader and library actually call. The
# catch-all proxy is authenticated, but without an allowlist it is still a relay
# into every Kavita endpoint (including the anonymous api/account/login, which
# would expose an otherwise LAN-only service to password guessing). Matched on
# the resource segment after "api/", case-insensitively (L6).
_KAVITA_ALLOWED_RESOURCES = {
    "book",
    "download",
    "image",
    "metadata",
    "person",
    "reader",
    "search",
    "series",
    "want-to-read",
}

# Prefix of Kavita's own ASP.NET Core OIDC/session cookies. The handshake routes
# forward and relay ONLY these — never the browser's WebServarr session cookie,
# and never arbitrary cookies Kavita might try to set on our origin (M8).
_ASPNET_COOKIE_PREFIX = ".AspNetCore."


def _filter_aspnet_cookie_header(cookie_header: str) -> str:
    """Keep only Kavita's own .AspNetCore.* cookies from a browser Cookie header.

    The browser's Cookie header for this origin also carries the WebServarr
    session id; forwarding the whole header to Kavita would hand it a live
    session credential (M8). Only the handshake's own correlation/nonce cookies
    are relevant to Kavita, so only those are passed through."""
    if not cookie_header:
        return ""
    keep = []
    for part in cookie_header.split(";"):
        p = part.strip()
        if not p:
            continue
        name = p.split("=", 1)[0].strip()
        if name.startswith(_ASPNET_COOKIE_PREFIX):
            keep.append(p)
    return "; ".join(keep)


def _force_signin_path(set_cookie: str) -> str:
    """Rewrite a Set-Cookie so its Path is pinned to /signin-oidc.

    Kavita's handshake cookies belong only on the callback path. Pinning the
    path stops a cookie from being scoped to the whole app origin, where it
    could shadow or fixate a cookie the app itself relies on (M8)."""
    parts = [
        seg for seg in set_cookie.split(";")
        if seg.strip().split("=", 1)[0].strip().lower() != "path"
    ]
    parts.append(" Path=/signin-oidc")
    return ";".join(parts)


def _origin(url: str) -> tuple:
    """(scheme, host, effective-port) for same-origin comparison."""
    p = urlparse(url or "")
    scheme = (p.scheme or "").lower()
    port = p.port or (443 if scheme == "https" else 80 if scheme == "http" else None)
    return scheme, (p.hostname or "").lower(), port


def _location_allowed(location: str, kavita_base: str) -> bool:
    """A handshake redirect may only point at Authentik or Kavita itself.

    Kavita's /oidc/login answers with a redirect to the Authentik authorize
    endpoint. Relaying that Location unchecked makes this route an open redirect
    (M8); confining it to the configured Authentik origin (or Kavita's own)
    closes that without affecting the real flow."""
    target = _origin(location)
    authentik = get_authentik_url()
    for allowed in (authentik, kavita_base):
        if allowed and _origin(allowed) == target:
            return True
    return False


def _kavita_path_allowed(path: str) -> bool:
    """True only for an api/<allowed-resource>/... path the reader legitimately
    uses. Rejects an embedded query/fragment in the captured path segment and
    anything outside the reader's resource allowlist (L6)."""
    if "?" in path or "#" in path:
        return False
    segments = path.split("/")
    if len(segments) < 2 or segments[0].lower() != "api":
        return False
    return segments[1].lower() in _KAVITA_ALLOWED_RESOURCES


# --- Book HTML sanitisation (H5) -------------------------------------------
#
# Kavita restyles book pages and rewrites their URLs but does NOT strip active
# content, and the reader inserts the returned HTML with innerHTML on the app's
# own origin. A poisoned EPUB (a book request auto-grabbed from an indexer, a
# shared folder, an uploader) could therefore run script as any signed-in user,
# admin included. Everything the browser receives is run through bleach here
# first, with a book-appropriate allowlist. Deliberately NOT shared with
# content.py: book HTML needs a far more permissive structural allowlist than
# user-authored markdown, and coupling the two would widen one to fit the other.
_BOOK_ALLOWED_TAGS = [
    "p", "div", "span", "br", "hr",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "dl", "dt", "dd",
    "blockquote", "pre", "code", "kbd", "samp", "var",
    "em", "strong", "b", "i", "u", "s", "del", "ins", "mark", "small",
    "sub", "sup", "abbr", "cite", "q", "time", "wbr",
    "a", "img", "figure", "figcaption",
    "section", "article", "aside", "header", "footer", "nav", "main", "address",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
    "col", "colgroup", "ruby", "rt", "rp", "bdi", "bdo",
]

# Attributes safe everywhere.
_BOOK_GLOBAL_ATTRS = {"class", "id", "title", "lang", "dir"}
# Extra attributes allowed on specific tags.
_BOOK_TAG_ATTRS = {
    "a": {"href", "name"},
    "img": {"src", "alt", "width", "height"},
    "td": {"colspan", "rowspan", "headers"},
    "th": {"colspan", "rowspan", "headers", "scope"},
    "col": {"span"},
    "colgroup": {"span"},
    "ol": {"start", "type", "reversed"},
    "bdo": {"dir"},
}

_BOOK_URI_SCHEME_RE = re.compile(r"^([a-z][a-z0-9+.\-]*):", re.IGNORECASE)

# bleach strips the <script>/<style> TAGS but keeps their text, which would show
# as raw CSS/JS in the book. Drop those element bodies first (cosmetic; bleach
# remains the security gate for anything this misses).
_SCRIPT_STYLE_BLOCK_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL)


def _allow_book_attr(tag: str, name: str, value: str) -> bool:
    """Per-attribute filter for book HTML.

    Drops every on* handler, allows a tight per-tag set, and constrains href/src
    to relative URLs and http(s); data: is permitted only as a genuine image
    payload on <img src>. javascript:/vbscript: are refused (bleach's own
    protocol filter is a second line of defence on top of this)."""
    if name.startswith("on"):
        return False
    if name in _BOOK_GLOBAL_ATTRS:
        return True
    if name not in _BOOK_TAG_ATTRS.get(tag, set()):
        return False
    if name in ("href", "src"):
        v = (value or "").strip().lower().replace("\t", "").replace("\n", "").replace("\r", "")
        m = _BOOK_URI_SCHEME_RE.match(v)
        if m:
            scheme = m.group(1)
            if scheme in ("http", "https"):
                return True
            if scheme == "data":
                return name == "src" and tag == "img" and v.startswith("data:image/")
            return False
        # No scheme => relative URL (e.g. /kavita/api/... after rewriting).
    return True


def sanitize_book_html(html: str) -> str:
    """Strip script/style/svg/math/iframe/object/embed, all handlers and unsafe
    URLs from rendered book HTML, keeping structural and formatting markup so the
    page still reads correctly. This is the XSS gate; run it last (H5)."""
    html = _SCRIPT_STYLE_BLOCK_RE.sub("", html)
    return bleach.clean(
        html,
        tags=_BOOK_ALLOWED_TAGS,
        attributes=_allow_book_attr,
        protocols=["http", "https", "data"],
        strip=True,
        strip_comments=True,
    )


def _read_settings(*keys: str) -> Dict[str, str]:
    """Read several settings rows in one query (short-lived session).

    Every requested key is present in the result; "" when unset."""
    db = SessionLocal()
    try:
        rows = db.query(Setting).filter(Setting.key.in_(keys)).all()
        found = {row.key: (row.value or "").strip() for row in rows}
        return {key: found.get(key, "") for key in keys}
    finally:
        db.close()


def _read_setting(key: str) -> str:
    """Read one settings row's value; "" when unset."""
    return _read_settings(key)[key]


def get_kavita_url() -> Optional[str]:
    """Read the configured Kavita base URL from settings."""
    return _read_setting("integration.kavita.url").rstrip("/") or None


def kavita_url_for(user: Dict[str, str]) -> Optional[str]:
    """The Kavita base URL for this caller, after the eBooks page switch.

    Raises 403 for a non-admin while eBooks is switched off (Settings > Pages);
    admins keep access so they can check the page while it is hidden. The switch
    is read in the same query as the URL because the reader sends every page,
    image and progress call through the proxy."""
    if user.get("is_admin") == "true":
        return get_kavita_url()
    values = _read_settings("integration.kavita.url", "sidebar.enabled_library")
    if switch_is_off(values["sidebar.enabled_library"]):
        raise HTTPException(status_code=403, detail="eBooks is turned off")
    return values["integration.kavita.url"].rstrip("/") or None


def get_authentik_url() -> str:
    """The Authentik base URL, resolved the way get_oidc_client resolves it.

    Installs configure Authentik in Settings -> Integrations (the settings
    table); the AUTHENTIK_URL environment variable is only a legacy fallback.
    Reading the env var alone left the handshake allow-list empty on every
    DB-configured install, so the real authorize redirect was refused."""
    return _read_setting("integration.authentik.url") or (settings.authentik_url or "").strip()


def build_forward_headers(request: Request, token: Optional[str]) -> Dict[str, str]:
    """Copy the inbound headers minus hop-by-hop ones, attaching the user's JWT.

    Client-supplied x-forwarded-* and cf-* headers are dropped (L6): the browser
    must never be able to dictate the forwarded-for chain or spoof Cloudflare
    metadata to Kavita."""
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in _HOP_BY_HOP
        and not k.lower().startswith("x-forwarded-")
        and not k.lower().startswith("cf-")
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    else:
        # Never forward a browser-supplied Authorization header — the only
        # credential Kavita should ever see is the one we attached ourselves.
        headers.pop("Authorization", None)
        headers.pop("authorization", None)
    return headers


def origin_headers(host: str) -> Dict[str, str]:
    """
    Headers that make Kavita generate correct absolute URLs.

    Kavita derives its OIDC redirect_uri from the Host header, so it must see
    the public WebServarr host rather than its own LAN address — otherwise it
    would ask Authentik to redirect to http://<kavita-host>:5000/signin-oidc, which
    is neither registered nor reachable from a browser.
    """
    return {
        "Host": host,
        "X-Forwarded-Host": host,
        "X-Forwarded-Proto": "https",
        "Accept": "*/*",
    }


def rewrite_book_html(html: str, base: str) -> str:
    """
    Make a rendered book page safe to display from WebServarr's origin.

    Kavita embeds absolute references to itself inside book HTML, for images and
    embedded fonts:

        //<kavita-host>:5000/api/book/18/book-resources?apiKey=<user key>&file=...

    Two problems. The host is LAN-only, so the browser cannot fetch it at all —
    every image and font in every book would fail. And the URL carries the
    user's Kavita API key, putting a credential into markup the page can read.

    Both are fixed by pointing those references back through this proxy and
    dropping the key, which the proxy re-injects server-side.
    """
    host = urlparse(base).netloc
    if not host:
        return html

    # //<kavita-host>:5000/api/...  and  http(s)://<kavita-host>:5000/api/...
    html = re.sub(
        r"(?:https?:)?//" + re.escape(host) + r"/api/",
        "/kavita/api/",
        html,
    )
    # Remove the leaked key in either parameter position.
    html = re.sub(r"([?&])apiKey=[^&\"'\s]*&", r"\1", html)
    html = re.sub(r"[?&]apiKey=[^&\"'\s]*", "", html)
    return html


def collect_cookies(response: httpx.Response) -> str:
    """Flatten a response's Set-Cookie headers into a Cookie request header."""
    pairs = [
        value.split(";", 1)[0]
        for key, value in response.headers.multi_items()
        if key.lower() == "set-cookie"
    ]
    return "; ".join(p for p in pairs if p)


def force_query_response_mode(location: str) -> str:
    """
    Swap response_mode=form_post for response_mode=query on an Authentik
    authorize URL.

    Kavita's OIDC client always asks for form_post, even though it only ever
    runs the plain authorization-code flow (no id_token in the front
    channel), where form_post buys nothing query mode doesn't already give -
    a code and a state, which a redirect carries just as well. form_post
    instead sends back an auto-submitting HTML page, and that page has to
    render before its onload script fires, which is the Authentik page
    users see flash before eBooks loads. ASP.NET Core's OIDC callback
    handler parses the response from the query string or the POST body
    depending on which one actually arrives, so Kavita's own callback
    handling is unaffected by which mode Authentik was told to use.
    """
    parsed = urlparse(location)
    params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    if params.get("response_mode") != "form_post":
        return location
    params["response_mode"] = "query"
    return parsed._replace(query=urlencode(params)).geturl()


@router.get("/kavita/connect", include_in_schema=False)
@limiter.limit("30/minute")
async def kavita_connect(
    request: Request,
    current_user: Dict[str, str] = Depends(get_current_user),
):
    """
    Begin the Kavita OIDC handshake.

    The caller already holds a WebServarr session, which means they already hold
    an Authentik session — so Authentik returns immediately and the user sees no
    prompt and no consent screen.
    """
    base = kavita_url_for(current_user)
    if not base:
        raise HTTPException(status_code=503, detail="Kavita is not configured")

    host = request.headers.get("host", "")

    try:
        async with httpx.AsyncClient(timeout=PROXY_TIMEOUT, follow_redirects=False) as client:
            upstream = await client.get(f"{base}/oidc/login", headers=origin_headers(host))
    except httpx.RequestError as exc:
        logger.warning("Kavita connect failed: %s", exc)
        raise HTTPException(status_code=503, detail="Kavita is unavailable")

    location = upstream.headers.get("location")
    if not location:
        logger.warning("Kavita /oidc/login did not redirect (HTTP %d)", upstream.status_code)
        # 503, not 502: Cloudflare replaces 502/504/520-526 response bodies
        # with its own generic error page regardless of what origin sends.
        raise HTTPException(status_code=503, detail="Kavita did not start the login flow")

    # Relaying the upstream Location unchecked would be an open redirect (M8):
    # confine it to the Authentik authorize endpoint (or Kavita itself).
    if not _location_allowed(location, base):
        logger.warning("Kavita /oidc/login redirected to an unexpected origin")
        raise HTTPException(status_code=503, detail="Kavita login redirected somewhere unexpected")

    location = force_query_response_mode(location)
    response = RedirectResponse(location, status_code=302)

    # Kavita sets its OIDC nonce and correlation cookies here, scoped to
    # path=/signin-oidc. They must reach the browser or the callback fails with
    # "message.State is null or empty". Relay ONLY those .AspNetCore.* cookies,
    # each pinned to Path=/signin-oidc, so nothing else can be set on the app
    # origin (M8).
    for key, value in upstream.headers.multi_items():
        if key.lower() != "set-cookie":
            continue
        cookie_name = value.split("=", 1)[0].strip()
        if not cookie_name.startswith(_ASPNET_COOKIE_PREFIX):
            continue
        response.headers.append("set-cookie", _force_signin_path(value))

    return response


@router.api_route("/signin-oidc", methods=["GET", "POST"], include_in_schema=False)
@limiter.limit("30/minute")
async def signin_oidc(
    request: Request,
    session_id: str = Cookie(None, alias=settings.session_cookie_name),
):
    """
    Complete the Kavita OIDC handshake and store the user's Kavita JWT.

    Authentik posts here (response_mode=form_post). This lives at the app root
    because Kavita scopes its handshake cookies to path=/signin-oidc, and the
    browser only sends them to that exact path.

    Deliberately does not use get_current_user: an expired session should send
    the visitor to the login page, not return a bare 401 to a form POST.
    """
    session = await session_manager.get_session(session_id) if session_id else None
    if not session:
        return RedirectResponse("/login", status_code=302)

    try:
        base = kavita_url_for(session)
    except HTTPException as exc:
        if exc.status_code != 403:
            raise
        # eBooks was switched off mid-handshake: store no Kavita token and send
        # a member home, which is where the page gate would send them anyway.
        return RedirectResponse("/", status_code=302)
    if not base:
        raise HTTPException(status_code=503, detail="Kavita is not configured")

    host = request.headers.get("host", "")
    headers = origin_headers(host)
    # Forward ONLY Kavita's own .AspNetCore.* handshake cookies — never the
    # browser's WebServarr session cookie (M8).
    aspnet_cookies = _filter_aspnet_cookie_header(request.headers.get("cookie", ""))
    if aspnet_cookies:
        headers["Cookie"] = aspnet_cookies
    content_type = request.headers.get("content-type")
    if content_type:
        headers["Content-Type"] = content_type

    body = await request.body()
    token = None
    kavita_api_key = None

    try:
        async with httpx.AsyncClient(timeout=PROXY_TIMEOUT, follow_redirects=False) as client:
            callback = await client.request(
                request.method,
                f"{base}/signin-oidc",
                content=body,
                headers=headers,
                params=dict(request.query_params),
            )

            kavita_cookies = collect_cookies(callback)
            if kavita_cookies:
                # The callback leaves us holding Kavita's .AspNetCore.Cookies
                # session. Fetch the account with it to obtain that user's own
                # API key.
                #
                # /api/account returns `token: null` under cookie auth — Kavita
                # only mints JWTs on its JWT-issuing paths — so the key is what
                # we actually need. (/api/account/oidc-authenticated is only a
                # boolean "did OIDC succeed" check, not a token source.)
                account = await client.get(
                    f"{base}/api/account",
                    headers={**origin_headers(host), "Cookie": kavita_cookies},
                )
                if account.status_code != 200:
                    logger.warning(
                        "Kavita /api/account returned HTTP %d during handshake",
                        account.status_code,
                    )
                else:
                    api_key = (account.json() or {}).get("apiKey")
                    if api_key:
                        # Stored alongside the JWT because Kavita's image
                        # endpoints only accept a key as a query parameter
                        # (they are built for <img src>, which cannot send
                        # headers). The proxy injects it; the browser never
                        # sees it.
                        kavita_api_key = api_key
                        # Exchange the user's own API key for their JWT. Every
                        # proxied call then acts as them, so progress,
                        # bookmarks and highlights are genuinely per-user.
                        auth = await client.post(
                            f"{base}/api/Plugin/authenticate",
                            params={"apiKey": api_key, "pluginName": "WebServarr"},
                            headers=origin_headers(host),
                        )
                        if auth.status_code == 200:
                            token = (auth.json() or {}).get("token")
                        else:
                            logger.warning(
                                "Kavita Plugin/authenticate returned HTTP %d",
                                auth.status_code,
                            )
                    else:
                        logger.warning("Kavita account payload carried no apiKey")
    except httpx.RequestError as exc:
        logger.warning("Kavita callback failed: %s", exc)
        raise HTTPException(status_code=503, detail="Kavita is unavailable")

    if not token:
        logger.warning("Kavita handshake completed without a token (HTTP %d)", callback.status_code)
        return RedirectResponse("/ebooks?kavita=error", status_code=302)

    await session_manager.update_session(
        session_id,
        {"kavita_token": token, "kavita_api_key": kavita_api_key or ""},
    )
    return RedirectResponse("/ebooks", status_code=302)


@router.api_route(
    "/kavita/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    include_in_schema=False,
)
@limiter.limit("240/minute")
async def kavita_proxy(
    path: str,
    request: Request,
    current_user: Dict[str, str] = Depends(get_current_user),
):
    """
    Forward /kavita/<path> to Kavita, attaching this user's Kavita JWT.

    Authentication is mandatory. Without it this route would be an open relay
    into the home LAN.
    """
    base = kavita_url_for(current_user)
    if not base:
        raise HTTPException(status_code=503, detail="Kavita is not configured")

    # Only the reader/library's own resources may be reached (L6). Everything
    # else — anonymous login, admin, plugin auth — is refused so this
    # authenticated proxy cannot be turned into a general relay into the LAN.
    if not _kavita_path_allowed(path):
        raise HTTPException(status_code=404, detail="Not found")

    token = current_user.get("kavita_token") or None
    headers = build_forward_headers(request, token)
    body = await request.body()

    params = dict(request.query_params)
    # Kavita's asset endpoints reject the Bearer token and require an apiKey
    # query parameter, because they are designed for <img src> and CSS url()
    # references that cannot send headers. Inject it here so the key stays
    # server-side and never appears in markup the browser can read — book HTML
    # arrives with the key stripped by rewrite_book_html for exactly that reason.
    lowered = path.lower()
    if ("apiKey" not in params) and (
        lowered.startswith("api/image/") or "book-resources" in lowered
    ):
        api_key = current_user.get("kavita_api_key")
        if api_key:
            params["apiKey"] = api_key

    client = httpx.AsyncClient(timeout=PROXY_TIMEOUT)
    try:
        upstream_request = client.build_request(
            request.method,
            f"{base}/{path}",
            headers=headers,
            content=body,
            params=params,
        )
        upstream = await client.send(upstream_request, stream=True)
    except httpx.RequestError as exc:
        await client.aclose()
        logger.warning("Kavita proxy request failed for %s: %s", path, exc)
        raise HTTPException(status_code=503, detail="Kavita is unavailable")

    if upstream.status_code == 401:
        # The stored Kavita token is missing or expired. The frontend re-runs
        # the handshake at /kavita/connect and retries once.
        await upstream.aclose()
        await client.aclose()
        raise HTTPException(status_code=401, detail="Kavita session expired")

    response_headers = {
        k: v
        for k, v in upstream.headers.items()
        if k.lower() in _PASSTHROUGH_RESPONSE_HEADERS
    }

    # Rendered book pages must be rewritten before the browser sees them, which
    # means buffering. They are ~25 KB, so this is bounded; everything heavy
    # (covers, downloads) still streams.
    if _BOOK_PAGE_PATH.match(path):
        try:
            raw = await upstream.aread()
        finally:
            await upstream.aclose()
            await client.aclose()
        body = rewrite_book_html(raw.decode("utf-8", errors="replace"), base)
        # Sanitise LAST, so the bytes the browser receives are the gated ones
        # (H5): the reader inserts this HTML with innerHTML on the app origin.
        body = sanitize_book_html(body)
        response_headers.pop("content-length", None)
        # Defence in depth: if this content is ever loaded as a document rather
        # than fetched and inserted, sandbox it. allow-same-origin keeps the
        # parent able to read the DOM for annotations without allowing scripts.
        response_headers["Content-Security-Policy"] = "sandbox allow-same-origin"
        return Response(
            content=body,
            status_code=upstream.status_code,
            headers=response_headers,
            media_type=upstream.headers.get("content-type", "text/html; charset=utf-8"),
        )

    async def stream_body():
        try:
            async for chunk in upstream.aiter_bytes(chunk_size=65536):
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        stream_body(),
        status_code=upstream.status_code,
        headers=response_headers,
    )
