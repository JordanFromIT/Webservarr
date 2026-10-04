"""Tests for the dev kit's reserved-range guard and its database half.

Stdlib only, no app needed: run from the repo root with
    python3 -m unittest discover -s scripts/devkit -t scripts/devkit
"""
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import devkit  # noqa: E402

POSITIONS = ("CREATE TABLE listening_positions (identity TEXT, book_key TEXT, track_key TEXT, offset_ms INT, "
             "duration_ms INT, updated_at TEXT, device TEXT, source TEXT, book_ms INT, book_duration_ms INT, "
             "chapter_label TEXT, narrator TEXT, book_title TEXT, author TEXT, PRIMARY KEY (identity, book_key))")


class WithDatabase(unittest.TestCase):
    def database(self) -> sqlite3.Connection:
        conn = new_database()
        self.addCleanup(conn.close)
        return conn


def new_database() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.isolation_level = None
    conn.execute(POSITIONS)
    for table in devkit.IDENTITY_TABLES[1:]:
        conn.execute(f"CREATE TABLE {table} (identity TEXT, note TEXT)")
    conn.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value BLOB)")
    conn.execute("CREATE TABLE book_pair_overrides (id INTEGER PRIMARY KEY, action TEXT)")
    conn.execute("CREATE TABLE book_audio_editions (plex_book_key TEXT)")
    return conn


class ReservedRange(unittest.TestCase):
    def test_the_whole_range_is_reserved(self):
        for n in (990000, 990011, 990050, 990099):
            self.assertTrue(devkit.is_reserved(f"plex:{n}"), n)

    def test_everything_else_is_refused(self):
        for bad in ("plex:990100", "plex:989999", "plex:99001", "plex:9900", "plex:990011\n", " plex:990011",
                    "plex:990011 ", "plex:99001x", "plex:12345", "PLEX:990011", "oidc:990011", "local:990011",
                    "plex:９９００１１", "plex:990011:1", "plex:", "", None, 990011):
            self.assertFalse(devkit.is_reserved(bad), repr(bad))
            with self.assertRaises(devkit.DevkitError):
                devkit.require_reserved(bad)

    def test_the_command_line_refuses_an_identity_outside_the_range(self):
        parser = devkit.build_parser()
        for argv in (["session", "--role", "admin", "--identity", "plex:12345"],
                     ["seed-listen", "--identity", "plex:12345", "--book-key", "1:1", "--ms", "5"],
                     ["seed-orphan", "--identity", "oidc:990011", "--book-key", "1:1", "--ms", "5", "--author", "A"]):
            with _quiet(), self.assertRaises(SystemExit) as stopped:
                parser.parse_args(argv)
            self.assertEqual(stopped.exception.code, 2)

    def test_the_command_line_accepts_one_inside_it(self):
        args = devkit.build_parser().parse_args(
            ["seed-listen", "--identity", "plex:990011", "--book-key", "283644:1", "--ms", "5"])
        self.assertEqual(args.identity, "plex:990011")


class _quiet:
    """Swallow argparse's usage text on stderr while a refusal is expected."""
    def __enter__(self):
        self.saved, sys.stderr = sys.stderr, open("/dev/null", "w")

    def __exit__(self, *exc):
        sys.stderr.close()
        sys.stderr = self.saved
        return False


class Seeding(WithDatabase):
    def test_seed_writes_one_row_for_a_reserved_identity(self):
        conn = self.database()
        devkit.seed_position(conn, "plex:990011", "283644:1", 5000, now=datetime(2026, 1, 1, 12, 0, 0))
        row = conn.execute("SELECT identity, book_key, book_ms, book_duration_ms, updated_at "
                           "FROM listening_positions").fetchall()
        self.assertEqual(row, [("plex:990011", "283644:1", 5000, devkit.DEFAULT_DURATION_MS,
                                "2026-01-01 12:00:00.000000")])

    def test_seed_refuses_a_real_identity_and_writes_nothing(self):
        conn = self.database()
        with self.assertRaises(devkit.DevkitError):
            devkit.seed_position(conn, "plex:4242424", "283644:1", 5000)
        self.assertEqual(conn.execute("SELECT count(*) FROM listening_positions").fetchone()[0], 0)

    def test_seed_refuses_a_place_past_the_end_and_a_bad_key(self):
        conn = self.database()
        with self.assertRaises(devkit.DevkitError):
            devkit.seed_position(conn, "plex:990011", "1:1", devkit.DEFAULT_DURATION_MS + 1)
        with self.assertRaises(devkit.DevkitError):
            devkit.seed_position(conn, "plex:990011", "1:1'; DROP TABLE x;--", 1)

    def test_an_orphan_is_refused_when_the_book_is_in_the_library(self):
        conn = self.database()
        conn.execute("INSERT INTO book_audio_editions VALUES ('77:1')")
        with self.assertRaises(devkit.DevkitError):
            devkit.require_not_in_library(conn, "77:1")
        devkit.require_not_in_library(conn, "78:1")


class Cleanup(WithDatabase):
    def test_cleanup_removes_the_range_and_leaves_everyone_else(self):
        conn = self.database()
        for identity in ("plex:990011", "plex:990099", "plex:990100", "plex:12345", "local:7", "plex:99001"):
            for table in devkit.IDENTITY_TABLES[1:]:
                conn.execute(f"INSERT INTO {table} VALUES (?, 'x')", (identity,))
            conn.execute("INSERT INTO listening_positions (identity, book_key, track_key, offset_ms, duration_ms, "
                         "updated_at, device, source) VALUES (?, '1:1', '1', 0, 0, 'now', 'd', 'web')", (identity,))
        removed = devkit.delete_reserved_rows(conn)
        self.assertEqual(set(removed.values()), {2})
        for table in devkit.IDENTITY_TABLES:
            left = sorted(r[0] for r in conn.execute(f"SELECT identity FROM {table}"))
            self.assertEqual(left, ["local:7", "plex:12345", "plex:99001", "plex:990100"], table)


class SnapshotAndRestore(WithDatabase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp()) / "snaps"

    def test_restore_puts_every_table_back_exactly(self):
        conn = self.database()
        conn.execute("INSERT INTO settings VALUES ('a', 'one'), ('b', x'00ff10')")
        conn.execute("INSERT INTO listening_positions (identity, book_key, track_key, offset_ms, duration_ms, "
                     "updated_at, device, source) VALUES ('plex:12345', '9:1', '1', 0, 0, 'now', 'd', 'web')")
        before = devkit.read_tables(conn, list(devkit.DEFAULT_SNAPSHOT_TABLES))
        devkit.save_snapshot(conn, self.directory, "before", list(devkit.DEFAULT_SNAPSHOT_TABLES))

        conn.execute("UPDATE settings SET value = 'changed' WHERE key = 'a'")
        conn.execute("DELETE FROM settings WHERE key = 'b'")
        conn.execute("INSERT INTO settings VALUES ('c', 'new')")
        conn.execute("DELETE FROM listening_positions")
        conn.execute("INSERT INTO player_prefs VALUES ('plex:990011', 'x')")

        devkit.restore_snapshot(conn, self.directory, "before")
        after = devkit.read_tables(conn, list(devkit.DEFAULT_SNAPSHOT_TABLES))
        for table in before:
            self.assertEqual(devkit.digest(before[table]["rows"]), devkit.digest(after[table]["rows"]), table)
        self.assertEqual(conn.execute("SELECT value FROM settings WHERE key = 'b'").fetchone()[0], b"\x00\xff\x10")
        self.assertFalse((self.directory / "before.json").exists())

    def test_a_snapshot_is_private_and_is_never_overwritten(self):
        conn = self.database()
        devkit.save_snapshot(conn, self.directory, "keep", ["settings"])
        self.assertEqual((self.directory / "keep.json").stat().st_mode & 0o777, 0o600)
        with self.assertRaises(devkit.DevkitError):
            devkit.save_snapshot(conn, self.directory, "keep", ["settings"])

    def test_names_and_tables_are_checked_before_they_reach_the_filesystem_or_sql(self):
        conn = self.database()
        for name in ("../x", "A", "", "a" * 41, "a/b", ".hidden"):
            with self.assertRaises(devkit.DevkitError):
                devkit.snapshot_file(self.directory, name)
        with self.assertRaises(devkit.DevkitError):
            devkit.save_snapshot(conn, self.directory, "ok", ["settings; DROP TABLE settings"])
        with self.assertRaises(devkit.DevkitError):
            devkit.save_snapshot(conn, self.directory, "ok", ["no_such_table"])

    def test_restoring_a_missing_snapshot_changes_nothing(self):
        conn = self.database()
        conn.execute("INSERT INTO settings VALUES ('a', 'one')")
        with self.assertRaises(devkit.DevkitError):
            devkit.restore_snapshot(conn, self.directory, "nope")
        self.assertEqual(conn.execute("SELECT count(*) FROM settings").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
