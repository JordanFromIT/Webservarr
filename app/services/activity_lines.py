"""
More event log lines: requests, issues fixed (from n8n) and Kometa runs
(spec docs/superpowers/specs/2026-10-05-event-log-library-events-design.md,
section 11).

This module only words them, and refuses what must never be shown; storing
is status_feed's job (record_request, record_line). A line holds a title,
a year, an episode code, a book's format or a count: never a person, a
path, an address or a token.
"""

import re
from typing import Dict, List, Optional, Tuple

from app.services.library_lines import _line, _words

REQUESTED = "Requested"
FIXED = "Fixed"

# What n8n may send (section 11.2). Each problem's word, shown in brackets
# after the title ("other" shows none).
KINDS = ("issue_fixed",)
PROBLEMS = {
    "subtitles": "subtitles",
    "audio": "audio",
    "video": "video",
    "playback": "playback",
    "wrong_file": "wrong file",
    "other": "",
}
TITLE_MAX = 120
REF_MAX = 64

# Kometa's run_end, per Plex library type ("" when no library could be typed).
POSTERS = {
    "movie": "Movie posters updated",
    "show": "TV show posters updated",
    "": "Posters updated",
}


class Refused(ValueError):
    """A body n8n sent that makes no line: the reason, never the value."""


# --- Requests ----------------------------------------------------------------------------

def request_line(title, year=None, fmt: str = "") -> Optional[str]:
    """"Requested: Dune Messiah (2026)", "Requested: Severance",
    "Requested: Dune Messiah (audiobook)"; None without a title."""
    title = _words(title)
    if not title:
        return None
    if fmt in ("audiobook", "ebook"):
        tail = f" ({fmt})"
    elif isinstance(year, int) and not isinstance(year, bool) and 1800 < year < 3000:
        tail = f" ({year})"
    else:
        tail = ""
    return _line(REQUESTED, title, tail)


def burst_line(count: int) -> str:
    """A burst of requests folded into one line: "Requested: 5 titles"."""
    return f"{REQUESTED}: {count} titles"


# --- Screening ---------------------------------------------------------------------------

_URL = re.compile(r"[a-z][a-z0-9+.\-]*://|\bwww\.|\b[a-z0-9\-]+\.(?:com|net|org|io|tv|me|app|dev|co|uk|us|"
                  r"ca|de|info|biz|xyz|local|lan|home|arpa|internal)\b", re.I)
_IPV4 = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")
_IPV6 = re.compile(r"(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}|::[0-9a-f]{1,4}", re.I)
_EMAIL_OR_HANDLE = re.compile(r"\S@|@\w")
_PATH = re.compile(r"\\|(?:^|\s)[/~]|\b[a-z]:/|/\S*/", re.I)
_HEX = re.compile(r"[0-9a-f]{16,}", re.I)


def screened(value: str) -> bool:
    """True when `value` is safe to show: no URL or domain, IP address,
    email or @handle, file path or long token, and at most TITLE_MAX
    characters."""
    if len(value) > TITLE_MAX:
        return False
    for pattern in (_URL, _IPV4, _IPV6, _EMAIL_OR_HANDLE, _PATH, _HEX):
        if pattern.search(value):
            return False
    return not any(len(word) >= 20 and any(c.isdigit() for c in word) for word in value.split())


# --- Fixed issues (n8n) ------------------------------------------------------------------

def _code(value) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, str) and re.fullmatch(r"S\d{2,4}E\d{2,4}", value.strip()):
        return value.strip()
    raise Refused("code must be null or like S02E03")


def _year(value) -> Optional[int]:
    if value is None or value == "":
        return None
    if isinstance(value, str) and re.fullmatch(r"\d{4}", value.strip()):
        value = int(value)
    if isinstance(value, int) and not isinstance(value, bool) and 1800 <= value <= 2999:
        return value
    raise Refused("year must be null or a year")


def _ref(value) -> str:
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return str(value)
    if isinstance(value, str) and re.fullmatch(rf"[A-Za-z0-9_.:\-]{{1,{REF_MAX}}}", value.strip()):
        return value.strip()
    raise Refused("ref must be the issue's id")


def fixed_line(body) -> Tuple[str, str]:
    """(line, ref) for an n8n body, e.g. ("Fixed: Severance S02E03
    (subtitles)", "123"). Raises Refused for anything that must not be shown or
    is not in the allowed set."""
    if not isinstance(body, dict):
        raise Refused("the body must be a JSON object")
    if body.get("kind") not in KINDS:
        raise Refused("unknown kind")
    problem = body.get("problem")
    if not isinstance(problem, str) or problem not in PROBLEMS:
        raise Refused("unknown problem")
    raw = body.get("title")
    title = _words(raw)
    if not title or not isinstance(raw, str) or len(raw) > TITLE_MAX or not screened(title):
        raise Refused("title refused")
    code, year, ref = _code(body.get("code")), _year(body.get("year")), _ref(body.get("ref"))
    tail = f" {code}" if code else (f" ({year})" if year else "")
    if PROBLEMS[problem]:
        tail += f" ({PROBLEMS[problem]})"
    return _line(FIXED, title, tail), ref


# --- Kometa ------------------------------------------------------------------------------

def poster_kinds(body, library_types: Dict[str, str]) -> List[str]:
    """The POSTERS keys a Kometa run_end makes lines for, from the libraries
    its `names` cover (each {"name": collection, "library": name}) and
    `library_types` ({Plex library title: type}). [""] when no library can
    be typed; [] when the typed ones are neither movies nor shows."""
    names = body.get("names") if isinstance(body, dict) else None
    # Only string libraries: a list or object there is unhashable in the set.
    libraries = {n["library"] for n in names if isinstance(n, dict) and isinstance(n.get("library"), str)} \
        if isinstance(names, list) else set()
    typed = {library_types[lib] for lib in libraries if lib in library_types}
    if not typed:
        return [""]
    return [kind for kind in ("movie", "show") if kind in typed]


def is_run_end(body) -> bool:
    return isinstance(body, dict) and body.get("event") == "run_end"
