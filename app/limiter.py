"""
Rate limiter instance — extracted to avoid circular imports between
app.main and the router modules that apply per-endpoint limits.
"""

from fastapi import Request

from slowapi import Limiter

from app.config import settings


def _get_client_ip(request: Request) -> str:
    """Get client IP, preferring Cloudflare's trusted header over spoofable XFF."""
    cf_ip = request.headers.get("cf-connecting-ip")
    if cf_ip:
        return cf_ip.strip()
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


limiter = Limiter(
    key_func=_get_client_ip,
    storage_uri=settings.redis_url,
    default_limits=["120/minute"],
)
