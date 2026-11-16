"""
Rate limiter instance — extracted to avoid circular imports between
app.main and the router modules that apply per-endpoint limits.
"""

import ipaddress
import inspect
from typing import Callable, Iterable, Optional, Tuple

from fastapi import Request
from fastapi import routing as fastapi_routing
from starlette.responses import Response
from starlette.routing import BaseRoute, Match
from starlette.types import Scope

from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware, _should_exempt, async_check_limits

from app.config import settings

# Cloudflare published edge ranges (https://www.cloudflare.com/ips/). The real
# client IP in CF-Connecting-IP / X-Forwarded-For is only trustworthy when the
# request actually reaches us through Cloudflare (one of these ranges) or through
# the local reverse proxy / cloudflared tunnel (loopback / private). A direct hit
# on the exposed origin port comes from the attacker's own public IP, so we must
# IGNORE the spoofable headers there and rate-limit by the real peer address —
# otherwise an attacker rotates CF-Connecting-IP to get unlimited login attempts.
_CLOUDFLARE_CIDRS = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
    "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
    "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
    "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
    "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
]
_TRUSTED_PROXY_NETS = [ipaddress.ip_network(c) for c in _CLOUDFLARE_CIDRS]


def _is_trusted_proxy(ip_str: str) -> bool:
    """True if the immediate peer is a trusted front proxy: a Cloudflare edge IP,
    or a loopback/private address (the cloudflared sidecar / docker bridge)."""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    if ip.is_loopback or ip.is_private:
        return True
    return any(ip in net for net in _TRUSTED_PROXY_NETS)


def _get_client_ip(request: Request) -> str:
    """Resolve the real client IP for rate limiting.

    Only honor the CF-Connecting-IP / X-Forwarded-For headers when the request
    actually came from a trusted proxy; otherwise use the direct peer address so
    a forged CF-Connecting-IP cannot rotate rate-limit buckets."""
    peer = request.client.host if request.client else None
    if peer and _is_trusted_proxy(peer):
        for header in ("cf-connecting-ip", "x-forwarded-for"):
            ip = _first_ip(request.headers.get(header))
            if ip:
                return ip
    return peer or "unknown"


def _first_ip(value) -> str:
    """The first entry of a comma-separated header that is an IP address, or
    "". Never an empty or junk entry: an empty key makes slowapi skip every
    limit (`X-Forwarded-For: ,203.0.113.7`)."""
    for part in (value or "").split(","):
        candidate = part.strip()
        try:
            ipaddress.ip_address(candidate)
        except ValueError:
            continue
        return candidate
    return ""


def rate_limit_key(request: Request) -> str:
    """The client's rate-limit bucket: its IPv4 address, or its IPv6 /64.

    One IPv6 subscriber usually holds a whole /64, so keying the full address
    would hand them a fresh budget for every address they rotate through."""
    ip = _get_client_ip(request)
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if isinstance(addr, ipaddress.IPv6Address):
        if addr.ipv4_mapped is not None:
            return str(addr.ipv4_mapped)
        return str(ipaddress.IPv6Network((int(addr), 64), strict=False))
    return ip


# swallow_errors + in_memory_fallback_enabled: when Redis refuses writes (a
# full data disk makes a persisting Redis answer MISCONF) or is unreachable,
# requests are counted per worker in memory instead of every page failing.
#
# key_style="endpoint": one budget per route function, whatever its path
# parameters carry. The default ("url") gave every concrete path its own
# budget, so /kometa/<token> guesses or /kavita/<path> traffic were never
# throttled, and slowapi's warning line printed the full path.
limiter = Limiter(
    key_func=rate_limit_key,
    storage_uri=settings.redis_url,
    default_limits=["120/minute"],
    key_style="endpoint",
    swallow_errors=True,
    in_memory_fallback_enabled=True,
)


def route_match(routes: Iterable[BaseRoute], scope: Scope) -> Tuple[Optional[Callable], dict]:
    """(the function that will answer this request, the scope routing will
    add for it: its path_params), or (None, {}) for a mount such as /static,
    a wrong method, or no route at all.

    Since FastAPI 0.137 each include_router() is one nested entry in
    app.routes with no endpoint of its own; iter_route_contexts lists the
    routes inside them in dispatch order. Without it (a flat layout) the
    routes are matched as they are. The first full match wins, as in routing.
    A mount has no endpoint attribute (its matched scope names its app as the
    endpoint, which is not a view), so it reads as None, as in slowapi."""
    flatten = getattr(fastapi_routing, "iter_route_contexts", None)
    for route in flatten(routes) if flatten else routes:
        match, child = route.matches(scope)
        if match == Match.FULL:
            endpoint = getattr(route, "endpoint", None)
            return endpoint, (child if endpoint is not None else {})
    return None, {}


def route_endpoint(routes: Iterable[BaseRoute], scope: Scope) -> Optional[Callable]:
    """The function that will answer this request, or None (see route_match)."""
    return route_match(routes, scope)[0]


class DefaultLimitsMiddleware(SlowAPIMiddleware):
    """slowapi's middleware, finding the endpoint inside included routers,
    and counting a route's own limit here, first.

    slowapi 0.1.9 looks for the endpoint in app.routes only, so on FastAPI
    0.137+ it found none for any router route and skipped the default limit
    for all of them. An exempt route is left alone, and every route without
    a limit of its own gets the default, as in slowapi.

    A route with its own limit is counted here too, with exactly its own
    limits, keys and costs (slowapi's own check), and marked done so its
    decorator does not count it again. The decorator alone counts only once
    FastAPI has resolved the route's dependencies (sign-in, admin,
    same-origin, the body), so a request any of those refused (a flood of
    401s, 403s, cross-origin or malformed posts) used to count against no
    limit at all. Here, before routing, every request to the route counts,
    and the budgets stay what each route declares (the /kavita proxy's 1200
    and 240, system stats' 600). The scope gets the path_params routing
    would give it, which some keys read (the /kavita budgets). Over a limit,
    the app's own 429 handler answers."""

    async def dispatch(self, request: Request, call_next) -> Response:
        app = request.app
        limiter: Limiter = app.state.limiter
        if not limiter.enabled:
            return await call_next(request)

        handler, child = route_match(app.routes, request.scope)
        if handler is not None and limiter._auto_check and _has_own_limits(limiter, handler):
            request.scope["path_params"] = {**request.scope.get("path_params", {}),
                                            **child.get("path_params", {})}
            try:
                limiter._check_request_limit(request, handler, False)
            except RateLimitExceeded as exc:
                on_429 = app.exception_handlers.get(RateLimitExceeded, _rate_limit_exceeded_handler)
                answer = on_429(request, exc)
                return await answer if inspect.isawaitable(answer) else answer
            request.state._rate_limiting_complete = True
            return await call_next(request)

        if _should_exempt(limiter, handler):
            return await call_next(request)

        error_response, should_inject_headers = await async_check_limits(limiter, request, handler, app)
        if error_response is not None:
            return error_response
        response = await call_next(request)
        if should_inject_headers:
            response = limiter._inject_headers(response, request.state.view_rate_limit)
        return response


def _has_own_limits(limiter: Limiter, handler: Callable) -> bool:
    name = f"{handler.__module__}.{handler.__name__}"
    if name in limiter._exempt_routes:
        return False
    return name in limiter._route_limits or name in limiter._dynamic_route_limits
