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
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

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

    client = httpx.AsyncClient(timeout=PROXY_TIMEOUT)
    try:
        upstream_request = client.build_request(
            request.method,
            f"{base}/{path}",
            headers=headers,
            content=body,
            params=dict(request.query_params),
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
