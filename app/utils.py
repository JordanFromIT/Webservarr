"""Shared utility functions."""

import ipaddress
import socket
from urllib.parse import urlparse


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
    multicast or reserved address — or an unresolvable host — is rejected, since
    legitimate browser push services are always public HTTPS hosts."""
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
        if ip.is_private or _is_dangerous_ip(ip):
            return False
    return True


# Magic byte signatures for image formats
_IMAGE_MAGIC = {
    "image/png": [b"\x89PNG\r\n\x1a\n"],
    "image/jpeg": [b"\xff\xd8\xff"],
    "image/webp": [],  # Special handling: RIFF....WEBP
    "image/gif": [b"GIF87a", b"GIF89a"],
    "image/svg+xml": [],  # Special handling: text prefix
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

    if content_type == "image/svg+xml":
        # SVG is text-based; check for XML or SVG opening tags
        try:
            text_start = file_bytes[:256].decode("utf-8", errors="ignore").strip().lower()
        except Exception:
            return False
        return text_start.startswith("<?xml") or text_start.startswith("<svg")

    signatures = _IMAGE_MAGIC.get(content_type)
    if signatures is None:
        return False
    if not signatures:
        return False

    return any(file_bytes[: len(sig)] == sig for sig in signatures)
