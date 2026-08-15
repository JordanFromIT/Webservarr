"""
Kavita reverse proxy.

Kavita is the ebook backend. It runs on mediaserver, is reachable only across
the WireGuard tunnel, and emits no CORS headers — so the browser can never call
it directly. Every request is proxied through here: same-origin for the browser,
plain HTTP server-side over the tunnel.

This is the same proxy pattern already used for Plex, Seerr, Netdata, Sonarr,
Radarr and Uptime Kuma. The browser only ever loads https://hmserver.tv, so
there is no mixed-content problem.

Kavita owns all per-user reading state (progress, bookmarks, highlights,
shelves). WebServarr stores none of it — it forwards the caller's Kavita JWT,
which is obtained by the OIDC handoff and kept in their Redis session.
"""

import logging
from typing import Dict, Optional

import httpx
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse, StreamingResponse

from app.auth import session_manager
from app.config import settings
from app.database import SessionLocal
from app.dependencies import get_current_user
from app.limiter import limiter
from app.models import Setting

logger = logging.getLogger(__name__)

router = APIRouter()

# Book pages and cover images are the bulk of traffic; allow a generous ceiling.
PROXY_TIMEOUT = 60.0

# Hop-by-hop headers must never be forwarded (RFC 9110 7.6.1).
#
# "accept-encoding" is stripped deliberately, not because it is hop-by-hop:
# browsers advertise br/zstd, Kavita honours brotli, and httpx cannot decode it
# without the optional brotli package. The compressed bytes would then be
# relayed while Content-Encoding is dropped, so the browser would render
# garbage. Asking upstream for identity keeps the proxy correct. The hop to
# Kavita is a ~23ms LAN link over WireGuard, so compression buys little here.
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


def get_kavita_url() -> Optional[str]:
    """Read the configured Kavita base URL from settings (short-lived session)."""
    db = SessionLocal()
    try:
        row = db.query(Setting).filter(Setting.key == "integration.kavita.url").first()
        return row.value.rstrip("/") if row and row.value else None
    finally:
        db.close()


def build_forward_headers(request: Request, token: Optional[str]) -> Dict[str, str]:
    """Copy the inbound headers minus hop-by-hop ones, attaching the user's JWT."""
    headers = {
        k: v for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP
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
    would ask Authentik to redirect to http://10.10.0.3:5000/signin-oidc, which
    is neither registered nor reachable from a browser.
    """
    return {
        "Host": host,
        "X-Forwarded-Host": host,
        "X-Forwarded-Proto": "https",
        "Accept": "*/*",
    }


def collect_cookies(response: httpx.Response) -> str:
    """Flatten a response's Set-Cookie headers into a Cookie request header."""
    pairs = [
        value.split(";", 1)[0]
        for key, value in response.headers.multi_items()
        if key.lower() == "set-cookie"
    ]
    return "; ".join(p for p in pairs if p)


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
    base = get_kavita_url()
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
        raise HTTPException(status_code=502, detail="Kavita did not start the login flow")

    response = RedirectResponse(location, status_code=302)

    # Kavita sets its OIDC nonce and correlation cookies here, scoped to
    # path=/signin-oidc. They must reach the browser or the callback fails with
    # "message.State is null or empty".
    for key, value in upstream.headers.multi_items():
        if key.lower() == "set-cookie":
            response.headers.append("set-cookie", value)

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
    if not session_id or not await session_manager.get_session(session_id):
        return RedirectResponse("/login", status_code=302)

    base = get_kavita_url()
    if not base:
        raise HTTPException(status_code=503, detail="Kavita is not configured")

    host = request.headers.get("host", "")
    headers = origin_headers(host)
    headers["Cookie"] = request.headers.get("cookie", "")
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
        return RedirectResponse("/library?kavita=error", status_code=302)

    await session_manager.update_session(
        session_id,
        {"kavita_token": token, "kavita_api_key": kavita_api_key or ""},
    )
    return RedirectResponse("/library", status_code=302)


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
    base = get_kavita_url()
    if not base:
        raise HTTPException(status_code=503, detail="Kavita is not configured")

    token = current_user.get("kavita_token") or None
    headers = build_forward_headers(request, token)
    body = await request.body()

    params = dict(request.query_params)
    # Kavita's image endpoints reject the Bearer token and require an apiKey
    # query parameter, because they are designed for <img src> tags that cannot
    # send headers. Inject it here so the key stays server-side and never
    # appears in markup the browser can read.
    if path.lower().startswith("api/image/") and "apiKey" not in params:
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

    async def stream_body():
        try:
            async for chunk in upstream.aiter_bytes(chunk_size=65536):
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    response_headers = {
        k: v
        for k, v in upstream.headers.items()
        if k.lower() in _PASSTHROUGH_RESPONSE_HEADERS
    }

    return StreamingResponse(
        stream_body(),
        status_code=upstream.status_code,
        headers=response_headers,
    )
