#!/usr/bin/env python3
"""Dev test kit: signed-in test sessions, seeded rows, snapshot and restore.

Runs INSIDE the dev container, from the app's working directory, so it can
import the app. The repo is not mounted in the container (only app/ and
data/ are), so feed the script through stdin:

    docker exec -i <container> python - <command> [args] < scripts/devkit/devkit.py

Every row and session the kit creates belongs to a reserved test identity,
plex:9900NN. That identity is the tag: seeding refuses any other identity and
cleanup only ever touches this range, so real people's data is out of reach.

Nothing here prints a secret. `session` prints the new session id (the cookie
value) and nothing else on stdout; everything else goes to stderr.

It runs only on a dev instance: every command first checks that the folder
holding the database is bind-mounted from a dev checkout, one whose folder
name ends in "-dev" (require_dev_instance). Piped into any other container,
it refuses before it reads the database or mints a session.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import io
import json
import os
import re
import sqlite3
import sys
import warnings
from contextlib import closing, redirect_stderr
from datetime import datetime, timedelta, timezone
from pathlib import Path

# plex:990000 to plex:990099. A session is the kit's if it carries one of these.
RESERVED_IDENTITY = re.compile(r"plex:9900[0-9]{2}")
RESERVED_ACCOUNT_IDS = range(990000, 990100)
DEFAULT_IDENTITY = {"admin": "plex:990001", "member": "plex:990002"}

# Tables keyed by a listener's identity: what cleanup scrubs. Every table with
# an identity column in app/models.py is here (test_devkit checks), so a test
# session leaves nothing behind: its Books visit in book_visits once listed
# the kit's identities as people ("Account 0001") on Insights.
IDENTITY_TABLES = ("listening_positions", "listening_log", "listening_claims",
                   "listening_dismissals", "player_prefs", "book_continue_hidden", "book_notice",
                   "listening_hourly", "book_requesters", "kavita_links", "reading_totals", "ebook_places",
                   "reading_minutes", "book_visits", "book_list", "book_queue", "book_ratings",
                   "listening_daily", "book_follows")
# What snapshot saves unless told otherwise: the identity tables plus the
# settings and the pairing choices that the Books checks change.
DEFAULT_SNAPSHOT_TABLES = IDENTITY_TABLES + ("settings", "book_pair_overrides")

SNAPSHOT_DIR = Path("/tmp/devkit")
SESSION_TTL_SECONDS = 8 * 3600  # a stray kit session expires on its own
DEFAULT_DURATION_MS = 36_000_000  # a ten hour book
TABLE_NAME = re.compile(r"[a-z_][a-z0-9_]*")
SNAPSHOT_NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,39}")
BOOK_KEY = re.compile(r"[0-9A-Za-z:_.-]{1,64}")


class DevkitError(Exception):
    """A refusal or failure the caller should read; its text is safe to print."""


# --- the reserved range ------------------------------------------------------

def is_reserved(identity: object) -> bool:
    return isinstance(identity, str) and RESERVED_IDENTITY.fullmatch(identity) is not None


def require_reserved(identity: object) -> str:
    if not is_reserved(identity):
        raise DevkitError(f"identity {identity!r} is outside the reserved test range plex:990000 to plex:990099")
    return identity  # type: ignore[return-value]


# --- the dev instance only ----------------------------------------------------

MOUNTINFO = Path("/proc/self/mountinfo")
DEV_CHECKOUT_SUFFIX = "-dev"
_MOUNT_ESCAPE = re.compile(r"\\([0-7]{3})")


def _unescape(field: str) -> str:
    """mountinfo writes a space, tab, newline or backslash in a path as \\ooo."""
    return _MOUNT_ESCAPE.sub(lambda m: chr(int(m.group(1), 8)), field)


def mount_source(mountinfo: str, path: str) -> str | None:
    """The folder mounted at the deepest mount point holding `path` (an
    absolute path), as mountinfo's root field gives it: for a bind mount, the
    folder on the host. None when no mount holds it."""
    best: tuple[str, str] | None = None
    for line in mountinfo.splitlines():
        fields = line.split(" ")
        if len(fields) < 5:
            continue
        root, point = _unescape(fields[3]), _unescape(fields[4])
        inside = path == point or path.startswith(point.rstrip("/") + "/")
        if inside and (best is None or len(point) > len(best[0])):
            best = (point, root)
    return None if best is None else best[1]


def require_dev_instance(db_path: str, mountinfo: str | None = None) -> None:
    """Refuse unless the folder holding the database is bind-mounted from a
    dev checkout: the mount's host folder sits in a folder whose name ends in
    DEV_CHECKOUT_SUFFIX (the dev checkout's data folder). Anything else,
    including a mount that can't be read, is refused."""
    if mountinfo is None:
        try:
            mountinfo = MOUNTINFO.read_text()
        except OSError as exc:
            raise DevkitError("refused: can't tell whether this is the dev instance "
                              f"(mounts unreadable: {type(exc).__name__})") from exc
    source = mount_source(mountinfo, os.path.dirname(os.path.abspath(db_path)))
    checkout = os.path.basename(os.path.dirname(source.rstrip("/"))) if source else ""
    if not checkout.endswith(DEV_CHECKOUT_SUFFIX) or checkout == DEV_CHECKOUT_SUFFIX:
        raise DevkitError("refused: this is not the dev instance (its database is not mounted from a "
                          f"*{DEV_CHECKOUT_SUFFIX} checkout)")


# --- database ----------------------------------------------------------------

def database_path() -> str:
    from app.config import settings
    prefix = "sqlite:///"
    if not settings.database_url.startswith(prefix):
        raise DevkitError("only a SQLite database is supported")
    return settings.database_url[len(prefix):]


def connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=30)
    conn.isolation_level = None  # explicit BEGIN/COMMIT below
    return conn


def table_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    """The table's column names; the name must be a real table (it is then safe
    to quote into SQL, which cannot bind identifiers)."""
    if not TABLE_NAME.fullmatch(table):
        raise DevkitError(f"not a table name: {table!r}")
    known = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone()
    if known is None:
        raise DevkitError(f"no such table: {table}")
    return [r[0] for r in conn.execute("SELECT name FROM pragma_table_info(?)", (table,))]


def _encode(value: object) -> object:
    return {"b64": base64.b64encode(value).decode()} if isinstance(value, bytes) else value


def _decode(value: object) -> object:
    return base64.b64decode(value["b64"]) if isinstance(value, dict) else value


def read_table(conn: sqlite3.Connection, table: str) -> dict:
    columns = table_columns(conn, table)
    rows = [[_encode(v) for v in row] for row in conn.execute(f'SELECT * FROM "{table}"')]
    return {"columns": columns, "rows": rows}


def digest(rows: list) -> str:
    """Order-independent fingerprint of a table's rows."""
    lines = sorted(json.dumps(row, sort_keys=True) for row in rows)
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()


def read_tables(conn: sqlite3.Connection, tables: list[str]) -> dict:
    conn.execute("BEGIN")  # one consistent read across tables
    try:
        return {t: read_table(conn, t) for t in tables}
    finally:
        conn.execute("COMMIT")


# --- snapshot and restore ----------------------------------------------------

def snapshot_file(directory: Path, name: str) -> Path:
    if not SNAPSHOT_NAME.fullmatch(name):
        raise DevkitError("a snapshot name is lowercase letters, digits, - and _ (40 at most)")
    return directory / f"{name}.json"


def save_snapshot(conn: sqlite3.Connection, directory: Path, name: str, tables: list[str]) -> dict:
    target = snapshot_file(directory, name)
    if target.exists():
        raise DevkitError(f"snapshot {name!r} already exists: restore it, or pick another name")
    data = {"tables": read_tables(conn, tables)}
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)  # settings hold secrets
    with os.fdopen(fd, "w") as handle:
        json.dump(data, handle)
    os.replace(temporary, target)
    return data


def restore_snapshot(conn: sqlite3.Connection, directory: Path, name: str) -> dict:
    """Put every saved table back exactly as it was, then check it matches.
    Returns {table: row count}. The snapshot file is deleted on success, so a
    stale one can never be restored over later work."""
    target = snapshot_file(directory, name)
    if not target.exists():
        raise DevkitError(f"no snapshot named {name!r}")
    saved = json.loads(target.read_text())["tables"]
    for table, content in saved.items():  # validate everything before changing anything
        if table_columns(conn, table) != content["columns"]:
            raise DevkitError(f"table {table} has changed shape since the snapshot; nothing restored")
    conn.execute("BEGIN IMMEDIATE")
    try:
        for table, content in saved.items():
            marks = ", ".join("?" for _ in content["columns"])
            names = ", ".join(f'"{c}"' for c in content["columns"])
            conn.execute(f'DELETE FROM "{table}"')
            conn.executemany(f'INSERT INTO "{table}" ({names}) VALUES ({marks})',
                             [[_decode(v) for v in row] for row in content["rows"]])
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")
    now = read_tables(conn, list(saved))
    differs = [t for t in saved if digest(now[t]["rows"]) != digest(saved[t]["rows"])]
    if differs:
        raise DevkitError(f"restored, but {', '.join(differs)} changed again straight after "
                          "(something else is writing); snapshot kept")
    target.unlink()
    return {t: len(c["rows"]) for t, c in saved.items()}


# --- cleanup and seeding -----------------------------------------------------

def delete_reserved_rows(conn: sqlite3.Connection) -> dict:
    """Delete every row of the reserved identities. Matches in Python, deletes by
    exact bound identity, so nothing outside the range can be reached."""
    removed: dict = {}
    conn.execute("BEGIN IMMEDIATE")
    try:
        for table in IDENTITY_TABLES:
            table_columns(conn, table)
            identities = [r[0] for r in conn.execute(f'SELECT DISTINCT identity FROM "{table}"')]
            count = 0
            for identity in filter(is_reserved, identities):
                count += conn.execute(f'DELETE FROM "{table}" WHERE identity = ?', (identity,)).rowcount
            removed[table] = count
        # Requests for access are keyed by the bare Plex account id.
        if conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'access_requests'").fetchone():
            count = 0
            for (account_id,) in conn.execute("SELECT plex_account_id FROM access_requests").fetchall():
                if is_reserved(f"plex:{account_id}"):
                    count += conn.execute("DELETE FROM access_requests WHERE plex_account_id = ?",
                                          (account_id,)).rowcount
            removed["access_requests"] = count
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")
    return removed


def seed_position(conn: sqlite3.Connection, identity: str, book_key: str, ms: int,
                  duration_ms: int | None = None, minutes_ago: int = 0, title: str | None = None,
                  author: str | None = None, narrator: str | None = None,
                  chapter: str | None = None, now: datetime | None = None) -> dict:
    """Set the identity's place in one book (replacing any row for that book)."""
    require_reserved(identity)
    if not BOOK_KEY.fullmatch(book_key):
        raise DevkitError(f"not a book key: {book_key!r}")
    if ms < 0 or minutes_ago < 0:
        raise DevkitError("--ms and --minutes-ago cannot be negative")
    duration = DEFAULT_DURATION_MS if duration_ms is None else duration_ms
    if ms > duration:
        raise DevkitError(f"--ms {ms} is past the book's length {duration}; pass --duration-ms")
    at = (now or datetime.now(timezone.utc).replace(tzinfo=None)) - timedelta(minutes=minutes_ago)
    conn.execute(
        'INSERT OR REPLACE INTO listening_positions (identity, book_key, track_key, offset_ms, duration_ms, '
        'updated_at, device, source, book_ms, book_duration_ms, chapter_label, narrator, book_title, author) '
        "VALUES (?, ?, '1', 0, 0, ?, 'devkit', 'web', ?, ?, ?, ?, ?, ?)",
        (identity, book_key, at.strftime("%Y-%m-%d %H:%M:%S.000000"), ms, duration, chapter, narrator, title, author))
    return {"identity": identity, "book_key": book_key, "book_ms": ms, "book_duration_ms": duration}


def require_not_in_library(conn: sqlite3.Connection, book_key: str) -> None:
    found = conn.execute("SELECT 1 FROM book_audio_editions WHERE plex_book_key = ?", (book_key,)).fetchone()
    if found is not None:
        raise DevkitError(f"book key {book_key} is in the library, so a place in it is not an orphan")


ACCESS_STATUSES = ("pending", "approved", "denied", "blocked")
SHARE_STATES = ("shared", "existing", "failed")


def seed_access(conn: sqlite3.Connection, identity: str, status: str, name: str, note: str,
                minutes_ago: int = 0, share_state: str | None = None, share_error: str | None = None,
                now: datetime | None = None) -> dict:
    """A request for access from a reserved identity (replacing any it has).
    Its username is devkit-<id>. Never approve one on a live site: approving
    shares the real Plex server with whoever holds that username, so live
    checks intercept the approve route."""
    require_reserved(identity)
    if status not in ACCESS_STATUSES:
        raise DevkitError(f"status must be one of {', '.join(ACCESS_STATUSES)}")
    if share_state is not None and (share_state not in SHARE_STATES or status != "approved"):
        raise DevkitError("--share-state is for an approved request only: shared, existing or failed")
    if minutes_ago < 0:
        raise DevkitError("--minutes-ago cannot be negative")
    account_id = identity.split(":", 1)[1]
    at = (now or datetime.now(timezone.utc).replace(tzinfo=None)) - timedelta(minutes=minutes_ago)
    stamp = at.strftime("%Y-%m-%d %H:%M:%S.000000")
    decided = None if status == "pending" else stamp
    cooldown = (at + timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S.000000") if status == "denied" else None
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("DELETE FROM access_requests WHERE plex_account_id = ?", (account_id,))
        conn.execute(
            "INSERT INTO access_requests (plex_account_id, plex_username, plex_email, plex_avatar_url, name, note, "
            "status, share_state, share_error, library_keys, created_at, decided_at, decided_by, cooldown_until) "
            "VALUES (?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (account_id, f"devkit-{account_id}", name, note, status, share_state, share_error,
             '["1"]' if status == "approved" else None, stamp, decided, "devkit" if decided else None, cooldown))
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")
    return {"identity": identity, "status": status, "share_state": share_state}


LOG_SOURCES = ("web", "plex", "local")
REQUEST_FORMATS = ("ebook", "audiobook", "both")
TITLE_MAX = 300
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def _now(now: datetime | None) -> datetime:
    return now or datetime.now(timezone.utc).replace(tzinfo=None)


def _stamp(at: datetime) -> str:
    return at.strftime("%Y-%m-%d %H:%M:%S.000000")


def _write(conn: sqlite3.Connection, statement: str, rows: list) -> None:
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.executemany(statement, rows)
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def seed_log(conn: sqlite3.Connection, identity: str, book_key: str, minutes_ago: int, minutes: int,
             source: str = "web", now: datetime | None = None) -> dict:
    """Listening in the check-in log, as the player writes it: a play row, a
    check-in every 10 s for `minutes`, then a pause, from `minutes_ago`
    minutes ago. Insights reads it (the hourly rollup takes it in at its next
    pass, if it is within two days of the last one)."""
    require_reserved(identity)
    if not BOOK_KEY.fullmatch(book_key):
        raise DevkitError(f"not a book key: {book_key!r}")
    if source not in LOG_SOURCES:
        raise DevkitError(f"--source must be one of {', '.join(LOG_SOURCES)}")
    if not 1 <= minutes <= 600 or minutes > minutes_ago:
        raise DevkitError("--minutes must be 1 to 600 and no more than --minutes-ago")
    start = _now(now) - timedelta(minutes=minutes_ago)
    rows = [(identity, book_key, "1", 0, "devkit", "play" if s == 0 else "checkin",
             _stamp(start + timedelta(seconds=s)), source) for s in range(0, minutes * 60, 10)]
    rows.append((identity, book_key, "1", 0, "devkit", "pause", _stamp(start + timedelta(minutes=minutes)), source))
    _write(conn, "INSERT INTO listening_log (identity, book_key, track_key, offset_ms, device, event, at, source) "
                 "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
    return {"identity": identity, "book_key": book_key, "rows": len(rows), "source": source}


def seed_hour(conn: sqlite3.Connection, identity: str, book_key: str, hours_ago: int, minutes: int,
              source: str = "web", now: datetime | None = None) -> dict:
    """One hour of listening in listening_hourly, `hours_ago` hours ago (any
    age, unlike the log), replacing that hour's row for the book and source."""
    require_reserved(identity)
    if not BOOK_KEY.fullmatch(book_key):
        raise DevkitError(f"not a book key: {book_key!r}")
    if source not in LOG_SOURCES:
        raise DevkitError(f"--source must be one of {', '.join(LOG_SOURCES)}")
    if hours_ago < 1 or not 1 <= minutes <= 60:
        raise DevkitError("--hours-ago must be 1 or more and --minutes 1 to 60")
    hour = (_now(now) - timedelta(hours=hours_ago)).replace(minute=0, second=0, microsecond=0)
    _write(conn, "INSERT INTO listening_hourly (identity, hour, book_key, source, ms) VALUES (?, ?, ?, ?, ?) "
                 "ON CONFLICT (identity, hour, book_key, source) DO UPDATE SET ms = excluded.ms",
           [(identity, _stamp(hour), book_key, source, minutes * 60000)])
    return {"identity": identity, "hour": _stamp(hour), "ms": minutes * 60000}


def seed_request(conn: sqlite3.Connection, identity: str, title: str, fmt: str, days_ago: int,
                 now: datetime | None = None) -> dict:
    """A book request from a test identity, `days_ago` days ago. Its Chaptarr
    id is devkit:<identity's number>; nothing is sent to Chaptarr."""
    require_reserved(identity)
    if not title or len(title) > TITLE_MAX or CONTROL.search(title):
        raise DevkitError(f"--title must be 1 to {TITLE_MAX} characters with no control characters")
    if fmt not in REQUEST_FORMATS:
        raise DevkitError(f"--format must be one of {', '.join(REQUEST_FORMATS)}")
    if days_ago < 0:
        raise DevkitError("--days-ago cannot be negative")
    at = _now(now) - timedelta(days=days_ago)
    _write(conn, "INSERT INTO book_requesters (identity, foreign_id, title, format, requested_at) "
                 "VALUES (?, ?, ?, ?, ?)", [(identity, "devkit:" + identity.split(":", 1)[1], title, fmt, _stamp(at))])
    return {"identity": identity, "format": fmt, "requested_at": _stamp(at)}


def seed_ebook(conn: sqlite3.Connection, identity: str, book_id: int, page: int, pages: int, days_ago: int,
               now: datetime | None = None) -> dict:
    """A place in a catalog ebook (its Books id), read `days_ago` days ago,
    replacing any the identity has in that book."""
    require_reserved(identity)
    if book_id < 1 or pages < 0 or not 0 <= page <= pages or days_ago < 0:
        raise DevkitError("--book-id must be 1 or more, --page 0 to --pages, --days-ago not negative")
    at = _now(now) - timedelta(days=days_ago)
    _write(conn, "INSERT INTO ebook_places (identity, book_id, page, pages, read_at, seen_at) VALUES (?, ?, ?, ?, ?, ?) "
                 "ON CONFLICT (identity, book_id) DO UPDATE SET page = excluded.page, pages = excluded.pages, "
                 "read_at = excluded.read_at, seen_at = excluded.seen_at",
           [(identity, book_id, page, pages, _stamp(at), _stamp(_now(now)))])
    return {"identity": identity, "book_id": book_id, "page": page, "pages": pages}


def seed_reading(conn: sqlite3.Connection, identity: str, pages_read: int, days_ago: int,
                 now: datetime | None = None) -> dict:
    """Pages a test identity read on one day, `days_ago` days ago, as Insights
    counts them. Insights keeps Kavita's lifetime total, one row a day, and a
    day's pages are the rise from the row before (spec 4.3), so a lone row
    reads nothing. The kit writes totals that give each seeded day exactly its
    pages: a zero total the day before the identity's earliest day, a day
    seeded again replaced, and every later total moved by the change."""
    require_reserved(identity)
    if pages_read < 0 or days_ago < 0:
        raise DevkitError("--pages-read and --days-ago cannot be negative")
    at = _now(now) - timedelta(days=days_ago)
    day = at.strftime("%Y-%m-%d")
    upsert = ("INSERT INTO reading_totals (identity, day, pages, words, hours, seen_at) VALUES (?, ?, ?, 0, 0, ?) "
              "ON CONFLICT (identity, day) DO UPDATE SET pages = excluded.pages, seen_at = excluded.seen_at")
    conn.execute("BEGIN IMMEDIATE")
    try:
        rows = conn.execute("SELECT day, pages FROM reading_totals WHERE identity = ? ORDER BY day",
                            (identity,)).fetchall()
        before = [pages for d, pages in rows if d < day]
        same = [pages for d, pages in rows if d == day]
        after = [pages for d, pages in rows if d > day]
        if not before:
            start = at - timedelta(days=1)
            conn.execute(upsert, (identity, start.strftime("%Y-%m-%d"), 0, _stamp(start)))
        total = (before[-1] if before else 0) + pages_read
        # The total the later rows rose from until now; moving them all by the
        # change keeps each later day's own rise.
        level = (same or before[-1:] or after[:1] or [total])[0]
        conn.execute(upsert, (identity, day, total, _stamp(at)))
        if total != level:
            conn.execute("UPDATE reading_totals SET pages = MAX(0, pages + ?) WHERE identity = ? AND day > ?",
                         (total - level, identity, day))
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")
    return {"identity": identity, "day": day, "pages_read": pages_read, "total": total}


# --- sessions (Redis) --------------------------------------------------------

async def mint_session(role: str, identity: str, kavita_link: bool) -> str:
    require_reserved(identity)
    from app.auth import session_manager
    from app.integrations import plex_player

    account_id = identity.split(":", 1)[1]
    try:
        plex_token = plex_player._admin()["token"] or ""
    except Exception as exc:  # the player and the Plex-backed pages need it; the rest do not
        print(f"devkit: no Plex token for the session ({type(exc).__name__})", file=sys.stderr)
        plex_token = ""
    session_id = session_manager.generate_session_id()
    await session_manager.create_session(session_id, {
        "user_id": account_id, "username": f"devkit-{account_id}", "display_name": f"Devkit {account_id}",
        "email": "", "is_admin": "true" if role == "admin" else "false", "auth_method": "plex",
        "plex_account_id": account_id, "plex_token": plex_token, "avatar_url": "", "id_token": "",
    })
    redis = await session_manager.get_redis()
    await redis.expire(f"session:{session_id}", SESSION_TTL_SECONDS)
    if kavita_link:
        try:
            await attach_kavita(session_id)
        except BaseException:
            await redis.delete(f"session:{session_id}")
            raise
    return session_id


async def attach_kavita(session_id: str) -> None:
    import httpx
    from app.auth import session_manager
    from app.integrations import kavita

    try:
        base, key = kavita._config()
        async with httpx.AsyncClient(timeout=20) as client:
            token = await kavita._token(client, base, key)
    except kavita.KavitaUnavailable as exc:
        raise DevkitError(f"cannot link Kavita: {exc}") from None
    await session_manager.update_session(
        session_id, {"kavita_token": token, "kavita_api_key": "", "kavita_base": base})


async def purge_sessions() -> int:
    """Delete every session of a reserved identity, its chapter-check shortcuts
    and the per-identity index sets. Returns how many sessions went."""
    from app.auth import session_manager

    redis = await session_manager.get_redis()
    removed = 0
    async for key in redis.scan_iter(match="session:*", count=500):
        method, user_id = [(f or b"").decode() for f in await redis.hmget(key, "auth_method", "user_id")]
        if method != "plex" or not is_reserved(f"plex:{user_id}"):
            continue
        session_id = key.decode().split(":", 1)[1]
        async for shortcut in redis.scan_iter(match=f"kavita_chapter_ok:{session_id}:*", count=500):
            await redis.delete(shortcut)
        await redis.delete(key)
        removed += 1
    await redis.delete(*[f"user_sessions:plex:{n}" for n in RESERVED_ACCOUNT_IDS])
    return removed


async def finish(coro):
    """Run a coroutine, then close the app's shared Redis connection."""
    from app.auth import session_manager
    try:
        return await coro
    finally:
        await session_manager.close()


# --- command line ------------------------------------------------------------

def identity_arg(value: str) -> str:
    try:
        return require_reserved(value)
    except DevkitError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from None


def snapshot_name_arg(value: str) -> str:
    try:
        snapshot_file(SNAPSHOT_DIR, value)
    except DevkitError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from None
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="devkit", description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)

    session = commands.add_parser("session", help="mint a signed-in test session; prints only its cookie value")
    session.add_argument("--role", choices=("admin", "member"), required=True)
    session.add_argument("--identity", type=identity_arg, help="plex:9900NN (default by role)")
    session.add_argument("--kavita-link", action="store_true", help="also sign the session in to Kavita")

    snapshot = commands.add_parser("snapshot", help="save the tables the checks touch")
    snapshot.add_argument("name", type=snapshot_name_arg)
    snapshot.add_argument("--also", default="", metavar="TABLE,TABLE",
                          help="more tables to save, e.g. books,book_audio_editions")

    restore = commands.add_parser("restore", help="put a snapshot back exactly and delete the kit's sessions")
    restore.add_argument("name", type=snapshot_name_arg)

    for name, summary in (("seed-listen", "set a test identity's place in a book"),
                          ("seed-orphan", "set a place in a book that is NOT in the library")):
        seed = commands.add_parser(name, help=summary)
        seed.add_argument("--identity", type=identity_arg, required=True)
        seed.add_argument("--book-key", required=True, help="a Plex book key such as 283644:1")
        seed.add_argument("--ms", type=int, required=True, help="place in the book, milliseconds")
        seed.add_argument("--duration-ms", type=int, help=f"book length (default {DEFAULT_DURATION_MS})")
        seed.add_argument("--minutes-ago", type=int, default=0, help="how long ago it was last played")
        seed.add_argument("--title")
        seed.add_argument("--author", required=name == "seed-orphan", help="the author an orphan is matched by")
        seed.add_argument("--narrator")
        seed.add_argument("--chapter")

    access = commands.add_parser("seed-access", help="seed a request for access from a test identity")
    access.add_argument("--identity", type=identity_arg, required=True)
    access.add_argument("--status", choices=ACCESS_STATUSES, default="pending")
    access.add_argument("--name", default="Devkit Person")
    # The default note has a second line and one 200-letter word, so a live
    # check sees line breaks kept and a long word wrapped at 390 wide.
    access.add_argument("--note", default="A test request from the dev kit.\nIt has a second line and one long word: "
                        + "w" * 200)
    access.add_argument("--minutes-ago", type=int, default=0)
    access.add_argument("--share-state", choices=SHARE_STATES)
    access.add_argument("--share-error")

    log = commands.add_parser("seed-log", help="seed listening in the check-in log (Insights)")
    log.add_argument("--identity", type=identity_arg, required=True)
    log.add_argument("--book-key", required=True)
    log.add_argument("--minutes-ago", type=int, required=True)
    log.add_argument("--minutes", type=int, required=True)
    log.add_argument("--source", choices=LOG_SOURCES, default="web")

    hour = commands.add_parser("seed-hour", help="seed one hour of listening by the hour (Insights, any age)")
    hour.add_argument("--identity", type=identity_arg, required=True)
    hour.add_argument("--book-key", required=True)
    hour.add_argument("--hours-ago", type=int, required=True)
    hour.add_argument("--minutes", type=int, required=True)
    hour.add_argument("--source", choices=LOG_SOURCES, default="web")

    request = commands.add_parser("seed-request", help="seed a book request (Insights' requested then read)")
    request.add_argument("--identity", type=identity_arg, required=True)
    request.add_argument("--title", required=True)
    request.add_argument("--format", choices=REQUEST_FORMATS, default="both")
    request.add_argument("--days-ago", type=int, default=0)

    ebook = commands.add_parser("seed-ebook", help="seed a place in a catalog ebook (Insights)")
    ebook.add_argument("--identity", type=identity_arg, required=True)
    ebook.add_argument("--book-id", type=int, required=True)
    ebook.add_argument("--page", type=int, required=True)
    ebook.add_argument("--pages", type=int, required=True)
    ebook.add_argument("--days-ago", type=int, default=0)

    reading = commands.add_parser("seed-reading", help="seed pages read on one day (Insights)")
    reading.add_argument("--identity", type=identity_arg, required=True)
    reading.add_argument("--pages-read", type=int, required=True, help="pages read that day")
    reading.add_argument("--days-ago", type=int, default=0)

    commands.add_parser("cleanup", help="remove every row and session of the reserved test identities")
    return parser


def import_app() -> None:
    """Import the app's modules once, with their deprecation noise swallowed, so
    stderr carries only the kit's own messages."""
    with redirect_stderr(io.StringIO()):
        import app.auth  # noqa: F401
        import app.config  # noqa: F401
        import app.integrations.kavita  # noqa: F401
        import app.integrations.plex_player  # noqa: F401


def run(args: argparse.Namespace) -> int:
    import_app()
    require_dev_instance(database_path())
    if args.command == "session":
        identity = args.identity or DEFAULT_IDENTITY[args.role]
        print(asyncio.run(finish(mint_session(args.role, identity, args.kavita_link))))
        return 0

    with closing(connect(database_path())) as conn:
        if args.command == "snapshot":
            extra = [t.strip() for t in args.also.split(",") if t.strip()]
            tables = list(dict.fromkeys(DEFAULT_SNAPSHOT_TABLES + tuple(extra)))
            data = save_snapshot(conn, SNAPSHOT_DIR, args.name, tables)
            rows = sum(len(t["rows"]) for t in data["tables"].values())
            print(f"snapshot {args.name}: {len(tables)} tables, {rows} rows")
        elif args.command == "restore":
            counts = restore_snapshot(conn, SNAPSHOT_DIR, args.name)
            gone = asyncio.run(finish(purge_sessions()))
            print(f"restored {args.name}: {sum(counts.values())} rows in {len(counts)} tables, "
                  f"{gone} kit sessions deleted")
        elif args.command in ("seed-listen", "seed-orphan"):
            if args.command == "seed-orphan":
                require_not_in_library(conn, args.book_key)
            placed = seed_position(conn, args.identity, args.book_key, args.ms, args.duration_ms,
                                   args.minutes_ago, args.title, args.author, args.narrator, args.chapter)
            print(json.dumps(placed))
        elif args.command == "seed-access":
            print(json.dumps(seed_access(conn, args.identity, args.status, args.name, args.note,
                                         args.minutes_ago, args.share_state, args.share_error)))
        elif args.command == "seed-log":
            print(json.dumps(seed_log(conn, args.identity, args.book_key, args.minutes_ago, args.minutes, args.source)))
        elif args.command == "seed-hour":
            print(json.dumps(seed_hour(conn, args.identity, args.book_key, args.hours_ago, args.minutes, args.source)))
        elif args.command == "seed-request":
            print(json.dumps(seed_request(conn, args.identity, args.title, args.format, args.days_ago)))
        elif args.command == "seed-ebook":
            print(json.dumps(seed_ebook(conn, args.identity, args.book_id, args.page, args.pages, args.days_ago)))
        elif args.command == "seed-reading":
            print(json.dumps(seed_reading(conn, args.identity, args.pages_read, args.days_ago)))
        elif args.command == "cleanup":
            removed = delete_reserved_rows(conn)
            gone = asyncio.run(finish(purge_sessions()))
            rows = ", ".join(f"{t} {n}" for t, n in removed.items())
            print(f"cleanup: rows deleted ({rows}); {gone} kit sessions deleted")
    return 0


def main(argv: list[str] | None = None) -> int:
    warnings.simplefilter("ignore")  # the app's libraries are noisy on stderr
    args = build_parser().parse_args(argv)
    try:
        return run(args)
    except DevkitError as exc:
        print(f"devkit: {exc}", file=sys.stderr)
        return 1
    except sqlite3.Error as exc:
        print(f"devkit: database error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
