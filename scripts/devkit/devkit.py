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

# Tables keyed by a listener's identity: what cleanup scrubs.
IDENTITY_TABLES = ("listening_positions", "listening_log", "listening_claims",
                   "listening_dismissals", "player_prefs", "book_continue_hidden")
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
