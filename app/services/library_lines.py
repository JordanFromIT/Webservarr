"""
Library events for the event log: what a Sonarr, Radarr or Chaptarr webhook
says, in plain words (spec
docs/superpowers/specs/2026-10-05-event-log-library-events-design.md,
section 3).

translate(app, body) turns one webhook body into a LibraryEvent, or None
when the event makes no line (a test ping, a health event, a rename in
Radarr, a delete for an upgrade, anything unknown or malformed). It never
raises, whatever JSON it is given. Storing it is status_feed's job
(record_library_event), which also groups Sonarr's per-file imports.

The wording is ACTIONS: one entry per row of the spec's table, so changing
what a line says is a one-line edit. A line holds only the action, the
title, the year, the episode code, a count, a book's format and
"(author)": never a requester, a user, a path or a release name.
"""

import hashlib
import re
from dataclasses import dataclass
from typing import Optional, Tuple

APPS = ("sonarr", "radarr", "chaptarr")

# (app, eventType, variant) -> the action that leads the line. The variant is
# what the payload decides: "upgrade" (isUpgrade), "files" (deletedFiles, the
# files went too), "many" (several episodes). What follows the title (a year,
# an episode code, "(8 episodes)", a book's format, "(author)") is the
# handler's. An eventType missing here makes no line.
ACTIONS = {
    ("radarr", "Grab", ""): "Downloading",
    ("radarr", "Download", ""): "Added",
    ("radarr", "Download", "upgrade"): "Upgraded",
    ("radarr", "MovieAdded", ""): "Monitored",
    ("radarr", "MovieDelete", ""): "Unmonitored",
    ("radarr", "MovieDelete", "files"): "Removed",
    ("radarr", "MovieFileDelete", ""): "Removed",

    ("sonarr", "Grab", ""): "Downloading",
    ("sonarr", "Grab", "many"): "Downloading",
    ("sonarr", "Download", ""): "Added",
    ("sonarr", "Download", "many"): "Added",
    ("sonarr", "Download", "upgrade"): "Upgraded",
    ("sonarr", "Download", "upgrade many"): "Upgraded",
    ("sonarr", "Rename", ""): "Files Renamed",
    ("sonarr", "SeriesAdd", ""): "Monitored",
    ("sonarr", "SeriesDelete", ""): "Unmonitored",
    ("sonarr", "SeriesDelete", "files"): "Removed",
    ("sonarr", "EpisodeFileDelete", ""): "Removed",
    ("sonarr", "EpisodeFileDelete", "many"): "Removed",

    ("chaptarr", "Grab", ""): "Downloading",
    ("chaptarr", "Download", ""): "Added",
    ("chaptarr", "Download", "upgrade"): "Upgraded",
    ("chaptarr", "BookDelete", ""): "Unmonitored",
    ("chaptarr", "BookDelete", "files"): "Removed",
    ("chaptarr", "BookFileDelete", ""): "Removed",
    ("chaptarr", "AuthorDelete", ""): "Unmonitored",
    ("chaptarr", "AuthorDelete", "files"): "Removed",
}

# The muted note after a grab's title (the event log shows it as " · <note>"):
# a grab can still fail, and no app says when it does.
GRAB_NOTE = "not guaranteed"

LINE_MAX = 199          # every line stays under 200 characters
KEY_MAX = 160
ELLIPSIS = "…"

# Chaptarr's quality names (Readarr's set) by format.
AUDIO_QUALITIES = {"M4B", "MP3", "FLAC", "M4A", "UNKNOWN AUDIO"}
EBOOK_QUALITIES = {"EPUB", "PDF", "MOBI", "AZW3", "AZW", "KEPUB"}


@dataclass(frozen=True)
class LibraryEvent:
    """One webhook, translated.

    kind: "line" (a line now), "file" (one of Sonarr's per-file imports: held
    back, then folded into its Import Complete or published alone) or
    "complete" (Sonarr's Import Complete: one line for the whole download).
    text: the line, without the grab note. upgrade_text: a "complete"'s line
    when any file it folds in was an upgrade. key: unique per app, event and
    file (or download) id, or None when the payload has no id. file_keys: a
    "complete"'s per-file keys. kind_word: what the line is, for the feed's
    row ("grab", "import", "upgrade" or "change")."""
    kind: str
    text: str
    key: Optional[str]
    kind_word: str
    note: str = ""
    upgrade_text: str = ""
    file_keys: Tuple[str, ...] = ()


# --- Reading JSON that may be any shape ------------------------------------------------

def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _list(value) -> list:
    return value if isinstance(value, list) else []


def _words(value) -> str:
    """A title as one clean line: no control characters, single spaces."""
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", "".join(c if c.isprintable() else " " for c in value)).strip()


def _id(value) -> Optional[str]:
    """An id as text: a positive int, or a short token (a download hash)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value) if value > 0 else None
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:\-]{1,100}", value.strip()):
        return value.strip()
    return None


def _year(value) -> Optional[int]:
    if isinstance(value, int) and not isinstance(value, bool) and 1800 < value < 3000:
        return value
    return None


def _flag(value) -> bool:
    return value is True


def _key(app: str, event: str, ident: Optional[str]) -> Optional[str]:
    if ident is None:
        return None
    key = f"{app}:{event.lower()}:{ident}"
    if len(key) > KEY_MAX:
        key = f"{app}:{event.lower()}:#{hashlib.sha256(ident.encode('utf-8')).hexdigest()}"
    return key


# --- The words -------------------------------------------------------------------------

def _line(action: str, title: str, tail: str = "") -> str:
    """"<action>: <title><tail>", the title cut with an ellipsis so the
    whole line stays within LINE_MAX."""
    head = f"{action}: "
    room = LINE_MAX - len(head) - len(tail)
    if len(title) > room:
        title = title[:max(room - 1, 0)].rstrip() + ELLIPSIS
    return f"{head}{title}{tail}"


def _movie(body: dict) -> Tuple[str, str]:
    movie = _dict(body.get("movie"))
    year = _year(movie.get("year"))
    return _words(movie.get("title")), f" ({year})" if year else ""


def _episodes_tail(episodes: list) -> Tuple[str, bool]:
    """(tail, many): " S02E03" for one episode, " S03 (8 episodes)" for
    several in one season, " (12 episodes)" across seasons, "" when none are
    listed."""
    seen = set()
    for ep in episodes:
        ep = _dict(ep)
        season, number = ep.get("seasonNumber"), ep.get("episodeNumber")
        if isinstance(season, int) and isinstance(number, int) and not isinstance(season, bool) \
                and not isinstance(number, bool) and season >= 0 and number >= 0:
            seen.add((season, number))
    if not seen:
        return "", False
    if len(seen) == 1:
        season, number = next(iter(seen))
        return f" S{season:02d}E{number:02d}", False
    seasons = {s for s, _ in seen}
    if len(seasons) == 1:
        return f" S{seasons.pop():02d} ({len(seen)} episodes)", True
    return f" ({len(seen)} episodes)", True


def _book_format(qualities, paths) -> str:
    """" (audiobook)" or " (ebook)" from the files' quality names, else from
    the path's root folder (/audiobooks, /ebooks); "" when neither says."""
    names = {q.strip().upper() for q in qualities if isinstance(q, str)}
    if names and names <= AUDIO_QUALITIES:
        return " (audiobook)"
    if names and names <= EBOOK_QUALITIES:
        return " (ebook)"
    for path in paths:
        if not isinstance(path, str):
            continue
        parts = {p.lower() for p in re.split(r"[\\/]", path) if p}
        if "audiobooks" in parts:
            return " (audiobook)"
        if "ebooks" in parts:
            return " (ebook)"
    return ""


# --- Per app ---------------------------------------------------------------------------

def _radarr(event: str, body: dict) -> Optional[LibraryEvent]:
    title, year = _movie(body)
    if not title:
        return None
    movie_id = _id(_dict(body.get("movie")).get("id"))
    if event == "Grab":
        return LibraryEvent("line", _line(ACTIONS["radarr", "Grab", ""], title, year),
                            _key("radarr", event, _id(body.get("downloadId"))), "grab", note=GRAB_NOTE)
    if event == "Download":
        movie_file = _dict(body.get("movieFile"))
        upgrade = _flag(body.get("isUpgrade"))
        return LibraryEvent("line", _line(ACTIONS["radarr", event, "upgrade" if upgrade else ""], title, year),
                            _key("radarr", event, _id(movie_file.get("id"))), "upgrade" if upgrade else "import")
    if event == "MovieAdded":
        return LibraryEvent("line", _line(ACTIONS["radarr", event, ""], title, year),
                            _key("radarr", event, movie_id), "change")
    if event == "MovieDelete":
        variant = "files" if _flag(body.get("deletedFiles")) else ""
        return LibraryEvent("line", _line(ACTIONS["radarr", event, variant], title, year),
                            _key("radarr", event, movie_id), "change")
    if event == "MovieFileDelete":
        reason = body.get("deleteReason")
        if isinstance(reason, str) and reason.strip().lower() == "upgrade":
            return None
        return LibraryEvent("line", _line(ACTIONS["radarr", event, ""], title, year),
                            _key("radarr", event, _id(_dict(body.get("movieFile")).get("id"))), "change")
    return None


def _sonarr(event: str, body: dict) -> Optional[LibraryEvent]:
    series = _dict(body.get("series"))
    title = _words(series.get("title"))
    if not title:
        return None
    series_id = _id(series.get("id"))
    tail, many = _episodes_tail(_list(body.get("episodes")))
    plural = " many" if many else ""
    if event == "Grab":
        return LibraryEvent("line", _line(ACTIONS["sonarr", event, plural.strip()], title, tail),
                            _key("sonarr", event, _id(body.get("downloadId"))), "grab", note=GRAB_NOTE)
    if event == "Download" and "episodeFiles" in body:
        files = [_dict(f) for f in _list(body.get("episodeFiles"))]
        ids = sorted({i for i in (_id(f.get("id")) for f in files) if i is not None})
        download = _id(body.get("downloadId"))
        ident = download or ("files-" + "-".join(ids) if ids else None)
        return LibraryEvent("complete", _line(ACTIONS["sonarr", event, plural.strip()], title, tail),
                            _key("sonarr", "complete", ident), "import",
                            upgrade_text=_line(ACTIONS["sonarr", event, ("upgrade" + plural)], title, tail),
                            file_keys=tuple(_key("sonarr", "file", i) for i in ids))
    if event == "Download":
        episode_file = _dict(body.get("episodeFile"))
        upgrade = _flag(body.get("isUpgrade"))
        variant = ("upgrade" + plural) if upgrade else plural.strip()
        return LibraryEvent("file", _line(ACTIONS["sonarr", event, variant], title, tail),
                            _key("sonarr", "file", _id(episode_file.get("id"))), "upgrade" if upgrade else "import")
    if event == "Rename":
        return LibraryEvent("line", _line(ACTIONS["sonarr", event, ""], title), None, "change")
    if event == "SeriesAdd":
        return LibraryEvent("line", _line(ACTIONS["sonarr", event, ""], title), _key("sonarr", event, series_id),
                            "change")
    if event == "SeriesDelete":
        variant = "files" if _flag(body.get("deletedFiles")) else ""
        return LibraryEvent("line", _line(ACTIONS["sonarr", event, variant], title), _key("sonarr", event, series_id),
                            "change")
    if event == "EpisodeFileDelete":
        reason = body.get("deleteReason")
        if isinstance(reason, str) and reason.strip().lower() == "upgrade":
            return None
        return LibraryEvent("line", _line(ACTIONS["sonarr", event, plural.strip()], title, tail),
                            _key("sonarr", event, _id(_dict(body.get("episodeFile")).get("id"))), "change")
    return None


def _chaptarr(event: str, body: dict) -> Optional[LibraryEvent]:
    author = _dict(body.get("author"))
    if event == "AuthorDelete":
        name = _words(author.get("name"))
        if not name:
            return None
        variant = "files" if _flag(body.get("deletedFiles")) else ""
        return LibraryEvent("line", _line(ACTIONS["chaptarr", event, variant], name, " (author)"),
                            _key("chaptarr", event, _id(author.get("id"))), "change")
    # A grab lists its books; every other book event carries one.
    books = [_dict(b) for b in _list(body.get("books"))] if event == "Grab" else [_dict(body.get("book"))]
    book = next((b for b in books if _words(b.get("title"))), None)
    if book is None:
        return None
    title = _words(book.get("title"))
    if event == "Grab":
        fmt = _book_format([_dict(body.get("release")).get("quality")], [author.get("path")])
        return LibraryEvent("line", _line(ACTIONS["chaptarr", event, ""], title, fmt),
                            _key("chaptarr", event, _id(body.get("downloadId"))), "grab", note=GRAB_NOTE)
    if event == "Download":
        files = [_dict(f) for f in _list(body.get("bookFiles"))]
        fmt = _book_format([f.get("quality") for f in files], [f.get("path") for f in files] + [author.get("path")])
        upgrade = _flag(body.get("isUpgrade"))
        ids = sorted({i for i in (_id(f.get("id")) for f in files) if i is not None})
        ident = "-".join(ids) if ids else _id(body.get("downloadId"))
        return LibraryEvent("line", _line(ACTIONS["chaptarr", event, "upgrade" if upgrade else ""], title, fmt),
                            _key("chaptarr", event, ident), "upgrade" if upgrade else "import")
    if event == "BookDelete":
        variant = "files" if _flag(body.get("deletedFiles")) else ""
        return LibraryEvent("line", _line(ACTIONS["chaptarr", event, variant], title),
                            _key("chaptarr", event, _id(book.get("id"))), "change")
    if event == "BookFileDelete":
        book_file = _dict(body.get("bookFile"))
        fmt = _book_format([book_file.get("quality")], [book_file.get("path"), author.get("path")])
        return LibraryEvent("line", _line(ACTIONS["chaptarr", event, ""], title, fmt),
                            _key("chaptarr", event, _id(book_file.get("id"))), "change")
    return None


_BY_APP = {"radarr": _radarr, "sonarr": _sonarr, "chaptarr": _chaptarr}
# The apps send "Grab", "MovieDelete", ...; any case is read as that name.
_EVENT_NAMES = {event.lower(): event for _, event, _ in ACTIONS}


def translate(app: str, body) -> Optional[LibraryEvent]:
    """The event log line `app`'s webhook body makes, or None (see the module's note)."""
    handler = _BY_APP.get(app)
    body = _dict(body)
    event = body.get("eventType")
    if handler is None or not isinstance(event, str):
        return None
    name = _EVENT_NAMES.get(event.strip().lower())
    return handler(name, body) if name else None
