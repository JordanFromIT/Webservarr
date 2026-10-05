"""The icons this site can draw.

Icons are Material Symbols ligatures ("home" in the icon font paints a house),
served from a trimmed copy of the font that holds only the names in
app/static/fonts/material-symbols-outlined.icons.txt (built by
scripts/build_icon_font.py). A name outside that list would paint as plain
letters, so an icon an admin typed in (the Settings icon picker, a wiki
category, a monitor) is checked here before it reaches a page: one the font
cannot draw is replaced by that slot's default icon.
"""

import pathlib

NAMES_FILE = pathlib.Path(__file__).resolve().parent / "static" / "fonts" / "material-symbols-outlined.icons.txt"


def _read_names() -> frozenset:
    try:
        lines = NAMES_FILE.read_text(encoding="utf-8").splitlines()
    except OSError:
        return frozenset()
    return frozenset(s for s in (line.strip() for line in lines) if s and not s.startswith("#"))


ICON_NAMES = _read_names()


def drawable(name) -> bool:
    """True when the icon font can draw `name`."""
    return isinstance(name, str) and name in ICON_NAMES


def icon_or(name, fallback: str) -> str:
    """`name` when the font can draw it, else `fallback`."""
    return name if drawable(name) else fallback
