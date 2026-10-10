"""Tests for the dev kit's reserved-range guard and its database half.

Stdlib only, no app needed: run from the repo root with
    python3 -m unittest discover -s scripts/devkit -t scripts/devkit
"""
import re
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


class EveryIdentityTable(unittest.TestCase):
    def test_cleanup_covers_every_table_keyed_by_identity(self):
        # A table the kit misses keeps a test identity's rows after cleanup:
        # book_visits did, and Insights listed the kit's sessions as people.
        models = (Path(__file__).resolve().parents[2] / "app" / "models.py").read_text()
        keyed = set()
        for block in models.split("\nclass ")[1:]:
            table = re.search(r'__tablename__ = "([a-z_]+)"', block)
            if table and re.search(r"^    identity = Column", block, re.M):
                keyed.add(table.group(1))
        self.assertIn("book_visits", keyed)
        self.assertEqual(sorted(keyed - set(devkit.IDENTITY_TABLES)), [])


ACCESS = ("CREATE TABLE access_requests (id INTEGER PRIMARY KEY, plex_account_id TEXT UNIQUE NOT NULL, "
          "plex_username TEXT NOT NULL, plex_email TEXT NOT NULL DEFAULT '', plex_avatar_url TEXT NOT NULL DEFAULT '', "
          "name TEXT NOT NULL, note TEXT NOT NULL, status TEXT NOT NULL, share_state TEXT, share_error TEXT, "
          "library_keys TEXT, created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, cooldown_until TEXT)")


class AccessSeeding(WithDatabase):
    def with_access(self) -> sqlite3.Connection:
        conn = self.database()
        conn.execute(ACCESS)
        return conn

    def rows(self, conn):
        return conn.execute("SELECT plex_account_id, plex_username, status, share_state, decided_at IS NOT NULL, "
                            "cooldown_until IS NOT NULL FROM access_requests ORDER BY plex_account_id").fetchall()

    def test_one_row_per_identity_and_each_status(self):
        conn = self.with_access()
        now = datetime(2026, 10, 10, 12, 0, 0)
        devkit.seed_access(conn, "plex:990011", "pending", "A", "n", now=now)
        devkit.seed_access(conn, "plex:990011", "denied", "A", "n", now=now)
        devkit.seed_access(conn, "plex:990012", "approved", "B", "n", share_state="failed",
                           share_error="Plex refused the share (HTTP 400)", now=now)
        devkit.seed_access(conn, "plex:990013", "blocked", "C", "n", now=now)
        self.assertEqual(self.rows(conn), [("990011", "devkit-990011", "denied", None, 1, 1),
                                           ("990012", "devkit-990012", "approved", "failed", 1, 0),
                                           ("990013", "devkit-990013", "blocked", None, 1, 0)])

    def test_refusals_write_nothing(self):
        conn = self.with_access()
        for args in (("plex:12345", "pending"), ("plex:990011", "maybe")):
            with self.subTest(args=args), self.assertRaises(devkit.DevkitError):
                devkit.seed_access(conn, args[0], args[1], "A", "n")
        with self.assertRaises(devkit.DevkitError):
            devkit.seed_access(conn, "plex:990011", "pending", "A", "n", share_state="failed")
        self.assertEqual(self.rows(conn), [])

    def test_cleanup_takes_only_the_reserved_range(self):
        conn = self.with_access()
        for account_id in ("990011", "990099", "990100", "12345"):
            conn.execute("INSERT INTO access_requests (plex_account_id, plex_username, name, note, status, created_at) "
                         "VALUES (?, 'u', 'n', 'n', 'pending', 'now')", (account_id,))
        removed = devkit.delete_reserved_rows(conn)
        self.assertEqual(removed["access_requests"], 2)
        left = sorted(r[0] for r in conn.execute("SELECT plex_account_id FROM access_requests"))
        self.assertEqual(left, ["12345", "990100"])

    def test_cleanup_without_the_table(self):
        self.assertNotIn("access_requests", devkit.delete_reserved_rows(self.database()))


INSIGHTS_TABLES = (
    "CREATE TABLE listening_log (id INTEGER PRIMARY KEY, identity TEXT NOT NULL, book_key TEXT NOT NULL, "
    "track_key TEXT NOT NULL, offset_ms INT NOT NULL, device TEXT NOT NULL, event TEXT NOT NULL, at TEXT NOT NULL, "
    "source TEXT NOT NULL DEFAULT 'web')",
    "CREATE TABLE listening_hourly (id INTEGER PRIMARY KEY, identity TEXT NOT NULL, hour TEXT NOT NULL, "
    "book_key TEXT NOT NULL, source TEXT NOT NULL, ms INT NOT NULL, UNIQUE (identity, hour, book_key, source))",
    "CREATE TABLE book_requesters (id INTEGER PRIMARY KEY, identity TEXT NOT NULL, foreign_id TEXT NOT NULL, "
    "title TEXT NOT NULL, format TEXT NOT NULL, requested_at TEXT NOT NULL)",
    "CREATE TABLE ebook_places (id INTEGER PRIMARY KEY, identity TEXT NOT NULL, book_id INT NOT NULL, page INT NOT NULL, "
    "pages INT NOT NULL, read_at TEXT, seen_at TEXT NOT NULL, UNIQUE (identity, book_id))",
    "CREATE TABLE reading_totals (id INTEGER PRIMARY KEY, identity TEXT NOT NULL, day TEXT NOT NULL, pages INT NOT NULL, "
    "words INT NOT NULL, hours INT NOT NULL, seen_at TEXT NOT NULL, UNIQUE (identity, day))",
)


class InsightsSeeding(unittest.TestCase):
    NOW = datetime(2026, 10, 10, 12, 0, 0)

    def conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(":memory:")
        conn.isolation_level = None
        for statement in INSIGHTS_TABLES:
            conn.execute(statement)
        self.addCleanup(conn.close)
        return conn

    def test_listening_in_the_log_and_by_the_hour(self):
        conn = self.conn()
        devkit.seed_log(conn, "plex:990011", "283644:1", 30, 2, source="plex", now=self.NOW)
        rows = conn.execute("SELECT event, at, source FROM listening_log ORDER BY at").fetchall()
        self.assertEqual(len(rows), 13)                                # 12 rows 10 s apart, then the pause
        self.assertEqual((rows[0][0], rows[0][1], rows[-1][0], rows[-1][1], rows[0][2]),
                         ("play", "2026-10-10 11:30:00.000000", "pause", "2026-10-10 11:32:00.000000", "plex"))
        devkit.seed_hour(conn, "plex:990011", "283644:1", 50, 30, now=self.NOW)
        devkit.seed_hour(conn, "plex:990011", "283644:1", 50, 45, now=self.NOW)
        self.assertEqual(conn.execute("SELECT hour, ms, source FROM listening_hourly").fetchall(),
                         [("2026-10-08 10:00:00.000000", 2700000, "web")])

    def test_requests_ebook_places_and_reading(self):
        conn = self.conn()
        devkit.seed_request(conn, "plex:990011", "W" * 300, "both", 3, now=self.NOW)
        devkit.seed_ebook(conn, "plex:990011", 7, 40, 300, 2, now=self.NOW)
        devkit.seed_ebook(conn, "plex:990011", 7, 60, 300, 1, now=self.NOW)
        devkit.seed_reading(conn, "plex:990011", 120, 1, now=self.NOW)
        devkit.seed_reading(conn, "plex:990011", 150, 1, now=self.NOW)              # the day again: replaced
        self.assertEqual(conn.execute("SELECT length(title), format, requested_at FROM book_requesters").fetchall(),
                         [(300, "both", "2026-10-07 12:00:00.000000")])
        self.assertEqual(conn.execute("SELECT book_id, page, read_at FROM ebook_places").fetchall(),
                         [(7, 60, "2026-10-09 12:00:00.000000")])
        self.assertEqual(conn.execute("SELECT day, pages FROM reading_totals ORDER BY day").fetchall(),
                         [("2026-10-08", 0), ("2026-10-09", 150)])

    @staticmethod
    def pages_read(conn) -> dict:
        """Pages read per day as Insights counts them (insights.reading_pages):
        the rise from the row before; a first row only sets where to rise from."""
        out, previous = {}, None
        for day, pages in conn.execute("SELECT day, pages FROM reading_totals ORDER BY day"):
            if previous is not None and pages > previous:
                out[day] = pages - previous
            previous = pages
        return out

    def test_each_seeded_day_reads_its_pages(self):
        conn = self.conn()
        devkit.seed_reading(conn, "plex:990012", 100, 3, now=self.NOW)
        devkit.seed_reading(conn, "plex:990012", 160, 1, now=self.NOW)
        self.assertEqual(self.pages_read(conn), {"2026-10-07": 100, "2026-10-09": 160})
        devkit.seed_reading(conn, "plex:990012", 40, 5, now=self.NOW)               # an earlier day, seeded after
        devkit.seed_reading(conn, "plex:990012", 70, 3, now=self.NOW)               # a day seeded again
        devkit.seed_reading(conn, "plex:990012", 25, 2, now=self.NOW)               # a day in between
        self.assertEqual(self.pages_read(conn),
                         {"2026-10-05": 40, "2026-10-07": 70, "2026-10-08": 25, "2026-10-09": 160})

    def test_refusals_write_nothing(self):
        conn = self.conn()
        refusals = (lambda: devkit.seed_log(conn, "plex:12345", "1:1", 10, 1),
                    lambda: devkit.seed_log(conn, "plex:990011", "1:1", 1, 5),            # longer than it has been
                    lambda: devkit.seed_log(conn, "plex:990011", "1:1", 10, 1, source="vinyl"),
                    lambda: devkit.seed_hour(conn, "plex:990011", "1:1", 1, 61),
                    lambda: devkit.seed_request(conn, "plex:990011", "", "both", 0),
                    lambda: devkit.seed_request(conn, "plex:990011", "x\u0007y", "both", 0),
                    lambda: devkit.seed_request(conn, "plex:990011", "x", "vinyl", 0),
                    lambda: devkit.seed_ebook(conn, "plex:990011", 7, 400, 300, 0),
                    lambda: devkit.seed_reading(conn, "oidc:990011", 5, 0))
        for refuse in refusals:
            with self.assertRaises(devkit.DevkitError):
                refuse()
        for table in ("listening_log", "listening_hourly", "book_requesters", "ebook_places", "reading_totals"):
            self.assertEqual(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0, table)


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
