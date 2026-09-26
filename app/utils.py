"""Shared utility functions."""

import ipaddress
import socket
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse, urlsplit


# --- Timestamps ---

def utc_iso(value: Optional[datetime]) -> Optional[str]:
    """A stored timestamp as ISO 8601 UTC with a Z, or None.

    The database keeps naive UTC (SQLite CURRENT_TIMESTAMP, datetime.utcnow()).
    Sent without a zone, a browser reads the time as its own local time, so
    west of UTC everything looks hours off. An aware value is converted."""
    if value is None:
        return None
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value.isoformat(timespec="milliseconds") + "Z"


# --- Account identity ---

def identity_email(value) -> str:
    """The email that identifies an account for notifications and push, or "".

    Stripped and lower-cased. Plex Home managed users and OIDC identities
    without an email claim have none; an older session stored that as the
    literal string "None", which made every such account share one identity
    (the same notifications, push subscriptions and preferences). "" and
    "none" therefore both mean "no identity": that account gets no
    notifications and no push.
    """
    if not isinstance(value, str):
        return ""
    v = value.strip().lower()
    return "" if v in ("", "none") else v


# --- Same-origin paths ---

def same_origin_path(value) -> str:
    """Return ``value`` as a same-origin absolute path (path, query, fragment), or "".

    ``startswith("/") and not startswith("//")`` is not enough: browsers
    parse URLs by the WHATWG rules, which treat a backslash as a slash and
    drop tabs and newlines anywhere, so "/\\evil.example" and "/<TAB>/evil.example"
    both resolve to another origin. Any backslash or
    control character is refused outright, and the result must carry no
    scheme or host.
    """
    if not isinstance(value, str):
        return ""
    v = value.strip()
    if not v.startswith("/") or v.startswith("//"):
        return ""
    if any(c == "\\" or ord(c) < 0x20 or ord(c) == 0x7F for c in v):
        return ""
    try:
        v.encode("utf-8")  # a lone surrogate can be neither stored nor served
        parts = urlsplit(v)
    except ValueError:  # UnicodeEncodeError is a ValueError
        return ""
    if parts.scheme or parts.netloc:
        return ""
    # The fragment is kept: it never reaches the server and cannot change the
    # origin (an SVG sprite reference like "/icons.svg#logo" needs it).
    return (
        parts.path
        + (f"?{parts.query}" if parts.query else "")
        + (f"#{parts.fragment}" if parts.fragment else "")
    )


def safe_http_url(value) -> str:
    """Return ``value`` if it is a well-formed absolute http(s) URL, else "".

    A prefix check is not enough: "http://[::1" passes one but makes
    urlsplit() raise, and anything that later parses the stored value (the
    link-preview builder does) would fail. The URL must parse, have an http
    or https scheme (any case) and a hostname, and a valid port if any.
    Backslashes and control characters are refused, because browsers and
    Python disagree on where the host ends around them.
    """
    if not isinstance(value, str):
        return ""
    v = value.strip()
    if not v or any(c == "\\" or ord(c) < 0x20 or ord(c) == 0x7F for c in v):
        return ""
    try:
        v.encode("utf-8")  # a lone surrogate can be neither stored nor served
        parts = urlsplit(v)
        host = parts.hostname
        parts.port  # raises ValueError for a malformed or out-of-range port
    except ValueError:  # UnicodeEncodeError is a ValueError
        return ""
    if parts.scheme.lower() not in ("http", "https") or not host:
        return ""
    return v


# --- SSRF guards for server-side outbound requests ---

def _resolve_ips(host: str):
    """Return a set of ip_address objects for host (literal IP or DNS-resolved).

    Empty set if the host cannot be resolved. Literal IPs skip DNS entirely
    (the common case — integrations are configured by IP)."""
    try:
        return {ipaddress.ip_address(host)}
    except ValueError:
        pass
    ips = set()
    try:
        for info in socket.getaddrinfo(host, None):
            try:
                ips.add(ipaddress.ip_address(info[4][0]))
            except ValueError:
                continue
    except (socket.gaierror, UnicodeError, OSError):
        pass
    return ips


def _is_dangerous_ip(ip) -> bool:
    """Loopback, link-local (incl. cloud metadata 169.254.169.254), multicast,
    unspecified or reserved — never a legitimate outbound target."""
    return (
        ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_unspecified
        or ip.is_reserved
    )


# Carrier-grade NAT (RFC 6598) and the equivalent shared IPv6 space. These are
# NOT flagged by is_private on every Python version, yet they route to the same
# LAN/Tailscale hosts an SSRF wants to reach — so they are rejected explicitly
# in addition to the is_global check below.
_CGNAT_NETS = (
    ipaddress.ip_network("100.64.0.0/10"),
)


def _is_public_routable(ip) -> bool:
    """True only for a globally-routable public address.

    is_global is the authoritative test (it already excludes private, loopback,
    link-local, CGNAT and reserved space), but the explicit CGNAT and
    _is_dangerous_ip checks make the intent obvious and stay correct across
    Python versions that have historically disagreed on 100.64.0.0/10."""
    if _is_dangerous_ip(ip):
        return False
    if ip.version == 4 and any(ip in net for net in _CGNAT_NETS):
        return False
    return bool(ip.is_global)


def is_safe_integration_url(url: str) -> bool:
    """Validate an admin-configured integration / test-connection URL.

    LAN / RFC-1918 hosts ARE allowed (Plex, *arr, Netdata live on the LAN), but
    loopback, link-local / cloud-metadata (169.254.0.0/16), multicast and
    reserved addresses are blocked. Only http/https. Hostnames that do not
    resolve are allowed (the admin is trusted and may use internal DNS names)."""
    parsed = urlparse((url or "").strip())
    if parsed.scheme.lower() not in ("http", "https"):
        return False
    host = parsed.hostname
    if not host:
        return False
    for ip in _resolve_ips(host):
        if _is_dangerous_ip(ip):
            return False
    return True


def is_safe_push_endpoint(url: str) -> bool:
    """Validate a user-supplied Web Push endpoint URL (anti-SSRF).

    Must be a public https URL. Any private/RFC-1918, loopback, link-local,
    multicast, reserved or CGNAT (100.64.0.0/10) address — anything not globally
    routable — or an unresolvable host, is rejected, since legitimate browser
    push services are always public HTTPS hosts. Every resolved address must
    pass, so a host that resolves to a mix of public and internal IPs is
    rejected outright (a DNS-rebind defence)."""
    parsed = urlparse((url or "").strip())
    if parsed.scheme.lower() != "https":
        return False
    host = parsed.hostname
    if not host:
        return False
    ips = _resolve_ips(host)
    if not ips:
        return False
    for ip in ips:
        if not _is_public_routable(ip):
            return False
    return True


# Magic byte signatures for image formats
_IMAGE_MAGIC = {
    "image/png": [b"\x89PNG\r\n\x1a\n"],
    "image/jpeg": [b"\xff\xd8\xff"],
    "image/webp": [],  # Special handling: RIFF....WEBP
    "image/gif": [b"GIF87a", b"GIF89a"],
    # NOTE: image/svg+xml is intentionally not accepted — SVG can carry inline
    # scripts and is served inline, which would be stored XSS.
}


def validate_image_magic(file_bytes: bytes, content_type: str) -> bool:
    """Verify that file bytes match the claimed content type via magic numbers.

    Returns True if the magic bytes match, False otherwise.
    Requires at least 12 bytes for reliable detection.
    """
    if len(file_bytes) < 4:
        return False

    if content_type == "image/webp":
        return (
            file_bytes[:4] == b"RIFF"
            and len(file_bytes) >= 12
            and file_bytes[8:12] == b"WEBP"
        )

    signatures = _IMAGE_MAGIC.get(content_type)
    if signatures is None:
        return False
    if not signatures:
        return False

    return any(file_bytes[: len(sig)] == sig for sig in signatures)
