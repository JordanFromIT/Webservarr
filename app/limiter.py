"""
Rate limiter instance — extracted to avoid circular imports between
app.main and the router modules that apply per-endpoint limits.
"""

import ipaddress

from fastapi import Request

from slowapi import Limiter

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
        cf_ip = request.headers.get("cf-connecting-ip")
        if cf_ip:
            return cf_ip.strip()
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return peer or "unknown"


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


# key_style="endpoint": one budget per route function, whatever its path
# parameters carry. The default ("url") gave every concrete path its own
# budget, so /kometa/<token> guesses or /kavita/<path> traffic were never
# throttled, and slowapi's warning line printed the full path.
limiter = Limiter(
    key_func=rate_limit_key,
    storage_uri=settings.redis_url,
    default_limits=["120/minute"],
    key_style="endpoint",
)
