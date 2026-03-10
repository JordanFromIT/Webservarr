"""Shared utility functions."""

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
