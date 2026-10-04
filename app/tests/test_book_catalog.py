"""
The Books catalog (sub-project 3a, task 1): the combined ebook and audiobook
store, its rebuild, its pairing overrides, the Chaptarr import webhook and the
server-side Kavita read.

Kavita and Plex are faked at the integration boundary (kavita.list_books and
plex_player.catalog_books). The lock and the start-up migration are tested
with real processes: the lock on one SQLite file and the suite's Redis
database, the migration on a copy of a database from before the catalog.
"""
import asyncio
import base64
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from unittest import mock

try:
    import httpx
    import redis as sync_redis

    from app.config import settings
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

if HAVE_APP:
    # Not in the guard above: a missing catalog module must fail the suite, not skip it.
    from app.integrations import kavita, plex_player
    from app.services import book_catalog

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def ebook(chapter_id, title, author="Frank Herbert", **kw):
    """A book as kavita.list_books gives it (its id is the chapter that is read)."""
    return {"id": chapter_id, "series_id": 100 + chapter_id, "volume_id": None, "library_id": 1, "title": title,
            "sort_title": title, "author": author, "series": "", "series_number": None, "description": "",
            "added_at": datetime(2026, 8, 1), **kw}


def audiobook(key, title, author="Frank Herbert", narrator="Scott Brick", **kw):
    return {"key": key, "title": title, "author": author, "series": "", "narrator": narrator, "cover": "",
            "duration_ms": 1000, "shape": "single", "work_key": plex_player.work_key(author, title, narrator),
            "sort_title": title, "description": "", "added_at": 1_700_000_000, "series_number": None, **kw}


class FakeSources:
    """What Kavita and Plex say, and whether they are down."""

    def __init__(self):
        self.ebooks = []
        self.audiobooks = []
        self.kavita_down = False
        self.plex_down = False

    async def list_books(self):
        if self.kavita_down:
            raise kavita.KavitaUnavailable("Kavita did not answer")
        return [dict(e) for e in self.ebooks]

    async def catalog_books(self):
        if self.plex_down:
            raise plex_player.PlayerUnavailable("Plex is unavailable")
        return [dict(a) for a in self.audiobooks]


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class CatalogCase(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.sources = FakeSources()
        for patcher in (
            mock.patch.object(book_catalog, "SessionLocal", self.Session),
            mock.patch.object(kavita, "list_books", self.sources.list_books),
            mock.patch.object(plex_player, "catalog_books", self.sources.catalog_books),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.clear_lock()
        self.addCleanup(self.clear_lock)

    @staticmethod
    def clear_lock():
        sync_redis.Redis.from_url(settings.redis_url).delete(book_catalog.LOCK_KEY)

    def rebuild(self):
        return asyncio.run(book_catalog.rebuild("test"))

    def db(self):
        return self.Session()

    def live(self):
        """{(kavita chapter id, plex key): book id} for the live books."""
        db = self.db()
        try:
            return {(b.kavita_chapter_id, b.plex_book_key): b.id
                    for b in db.query(book_catalog.Book).filter(book_catalog.Book.merged_into.is_(None))}
        finally:
            db.close()

    def book(self, book_id):
        db = self.db()
        try:
            row = db.get(book_catalog.Book, book_id)
            db.expunge(row)
            return row
        finally:
            db.close()

    def override(self, kavita_id, plex_key, action):
        db = self.db()
        try:
            book_catalog.set_override(db, kavita_id, plex_key, action, "admin")
        finally:
            db.close()


class Pairing(CatalogCase):
    def test_an_exact_work_key_pairs(self):
        self.sources.ebooks = [ebook(1, "Dune")]
        self.sources.audiobooks = [audiobook("10:1", "Dune")]
        out = self.rebuild()
        self.assertEqual((out["ok"], out["ebooks"], out["audiobooks"], out["books"], out["skipped"]),
                         (True, 1, 1, 1, False))
        self.assertEqual(set(self.live()), {(1, "10:1")})

    def test_differing_keys_stay_apart(self):
        self.sources.ebooks = [ebook(1, "Dune")]
        self.sources.audiobooks = [audiobook("10:1", "Dune Messiah")]
        out = self.rebuild()
        self.assertEqual(out["books"], 2)
        self.assertEqual(set(self.live()), {(1, None), (None, "10:1")})

    def test_a_key_more_than_one_item_has_is_too_uncertain_to_pair(self):
        self.sources.ebooks = [ebook(1, "Dune")]
        self.sources.audiobooks = [audiobook("10:1", "Dune"), audiobook("11:1", "Dune", narrator="Simon Vance")]
        self.rebuild()
        self.assertEqual(set(self.live()), {(1, None), (None, "10:1"), (None, "11:1")})

    def test_a_paired_book_shows_the_audiobook_title_and_both_dates(self):
        self.sources.ebooks = [ebook(1, "Dune", description="An ebook summary", added_at=datetime(2026, 8, 1))]
        self.sources.audiobooks = [audiobook("10:1", "Dune", description="", added_at=1_700_000_000)]
        self.rebuild()
        row = self.book(self.live()[(1, "10:1")])
        self.assertEqual((row.title, row.narrator, row.description), ("Dune", "Scott Brick", "An ebook summary"))
        self.assertEqual(row.ebook_added_at, datetime(2026, 8, 1))
        self.assertEqual(row.audio_added_at, datetime(2023, 11, 14, 22, 13, 20))
        self.assertEqual(row.added_at, row.audio_added_at)
        self.assertEqual(row.cover_source, "kavita")
        self.assertEqual(row.work_key, self.sources.audiobooks[0]["work_key"])


class Overrides(CatalogCase):
    def setUp(self):
        super().setUp()
        self.sources.ebooks = [ebook(1, "A Game of Thrones", "George R. R. Martin"),
                               ebook(2, "Dune")]
        self.sources.audiobooks = [audiobook("10:1", "A Song of Ice and Fire", "George R. R. Martin"),
                                   audiobook("20:1", "Dune")]

    def test_a_pair_override_joins_differing_keys(self):
        self.override(1, "10:1", "pair")
        self.rebuild()
        self.assertEqual(set(self.live()), {(1, "10:1"), (2, "20:1")})

    def test_an_apart_override_splits_matching_keys(self):
        self.override(2, "20:1", "apart")
        self.rebuild()
        self.assertEqual(set(self.live()), {(1, None), (2, None), (None, "10:1"), (None, "20:1")})

    def test_a_new_pair_for_the_same_item_replaces_the_old_one(self):
        self.override(1, "10:1", "pair")
        self.override(1, "20:1", "pair")      # the ebook moves to the other audiobook
        self.override(2, "20:1", "pair")      # and that audiobook moves again
        db = self.db()
        try:
            rows = [(o.kavita_chapter_id, o.plex_book_key, o.action)
                    for o in db.query(book_catalog.BookPairOverride).all()]
        finally:
            db.close()
        self.assertEqual(rows, [(2, "20:1", "pair")])
        self.rebuild()
        self.assertEqual(set(self.live()), {(2, "20:1"), (1, None), (None, "10:1")})

    def test_a_stale_second_pair_in_the_table_loses_to_the_newer_one(self):
        db = self.db()
        try:
            db.add_all([
                book_catalog.BookPairOverride(kavita_chapter_id=1, plex_book_key="10:1", action="pair",
                                              created_by="a", created_at=datetime(2026, 1, 1)),
                book_catalog.BookPairOverride(kavita_chapter_id=1, plex_book_key="20:1", action="pair",
                                              created_by="a", created_at=datetime(2026, 2, 1)),
            ])
            db.commit()
        finally:
            db.close()
        self.rebuild()
        self.assertEqual(set(self.live()), {(1, "20:1"), (2, None), (None, "10:1")})

    def test_an_override_survives_every_rebuild(self):
        self.override(1, "10:1", "pair")
        for _ in range(3):
            self.rebuild()
            self.assertIn((1, "10:1"), self.live())

    def test_removing_an_override_lets_the_keys_decide_again(self):
        self.override(2, "20:1", "apart")
        self.rebuild()
        db = self.db()
        try:
            self.assertTrue(book_catalog.remove_override(db, 2, "20:1"))
            self.assertFalse(book_catalog.remove_override(db, 2, "20:1"))
        finally:
            db.close()
        self.rebuild()
        self.assertIn((2, "20:1"), self.live())


class KeepLastGood(CatalogCase):
    def setUp(self):
        super().setUp()
        self.sources.ebooks = [ebook(1, "Dune"), ebook(2, "Emma", "Jane Austen")]
        self.sources.audiobooks = [audiobook("10:1", "Dune"), audiobook("30:1", "Ulysses", "James Joyce")]
        self.rebuild()
        self.before = self.live()

    def test_kavita_failing_leaves_the_ebook_side_as_it_was(self):
        self.sources.kavita_down = True
        self.sources.ebooks = []                       # what a broken source might claim
        self.sources.audiobooks.append(audiobook("40:1", "Persuasion", "Jane Austen"))
        out = self.rebuild()
        self.assertEqual(out["errors"], {"kavita": "Kavita did not answer", "plex": None})
        self.assertTrue(out["ok"])
        self.assertEqual(out["ebooks"], 2)
        after = self.live()
        for pair, book_id in self.before.items():
            self.assertEqual(after.get(pair), book_id)
        self.assertIn((None, "40:1"), after)           # the side that was read still moves

    def test_plex_failing_leaves_the_audiobook_side_as_it_was(self):
        self.sources.plex_down = True
        self.sources.audiobooks = []
        self.sources.ebooks.append(ebook(3, "Persuasion", "Jane Austen"))
        out = self.rebuild()
        self.assertEqual(out["errors"], {"kavita": None, "plex": "Plex is unavailable"})
        self.assertEqual(out["audiobooks"], 2)
        after = self.live()
        for pair, book_id in self.before.items():
            self.assertEqual(after.get(pair), book_id)
        self.assertIn((3, None), after)

    def test_both_failing_changes_nothing(self):
        self.sources.kavita_down = self.sources.plex_down = True
        out = self.rebuild()
        self.assertFalse(out["ok"])
        self.assertEqual(out["errors"], {"kavita": "Kavita did not answer", "plex": "Plex is unavailable"})
        self.assertEqual((out["ebooks"], out["audiobooks"], out["books"]), (2, 2, 3))
        self.assertEqual(self.live(), self.before)

    def test_a_paired_book_stays_paired_while_either_source_is_down(self):
        for down in ("kavita_down", "plex_down"):
            with self.subTest(down=down):
                setattr(self.sources, down, True)
                self.rebuild()
                self.assertEqual(self.live(), self.before)
                setattr(self.sources, down, False)

    def test_a_new_audiobook_pairs_with_an_ebook_held_from_a_failed_read(self):
        self.sources.kavita_down = True
        self.sources.audiobooks.append(audiobook("50:1", "Emma", "Jane Austen"))
        self.rebuild()
        live = self.live()
        self.assertNotIn((2, None), live)
        self.assertEqual(self.book(self.before[(2, None)]).merged_into, live[(2, "50:1")])

    def test_a_successful_read_removes_only_what_that_source_lost(self):
        self.sources.ebooks = [ebook(1, "Dune")]       # Emma is gone from Kavita
        self.sources.plex_down = True
        self.rebuild()
        after = self.live()
        self.assertNotIn((2, None), after)
        self.assertEqual(after[(1, "10:1")], self.before[(1, "10:1")])
        self.assertEqual(after[(None, "30:1")], self.before[(None, "30:1")])

        self.sources.plex_down = False
        self.sources.kavita_down = True
        self.sources.audiobooks = [audiobook("10:1", "Dune")]   # Ulysses is gone from Plex
        self.rebuild()
        after = self.live()
        self.assertNotIn((None, "30:1"), after)
        self.assertEqual(after[(1, "10:1")], self.before[(1, "10:1")])

    def test_ids_and_counts_are_stable_across_three_rebuilds(self):
        stamps = {b: self.book(b).updated_at for b in self.before.values()}
        for _ in range(3):
            out = self.rebuild()
            self.assertEqual(self.live(), self.before)
            self.assertEqual((out["ebooks"], out["audiobooks"], out["books"]), (2, 2, 3))
        self.assertEqual({b: self.book(b).updated_at for b in self.before.values()}, stamps)

    def test_status_reports_the_last_rebuild(self):
        self.sources.kavita_down = True
        self.rebuild()
        status = asyncio.run(book_catalog.catalog_status())
        self.assertEqual(status["counts"], {"ebooks": 2, "audiobooks": 2, "books": 3})
        self.assertEqual(status["errors"], {"kavita": "Kavita did not answer", "plex": None})
        self.assertFalse(status["running"])
        self.assertIsNotNone(status["last_rebuild_at"])
        self.assertIsNotNone(status["last_ok_at"])


class IdPolicy(CatalogCase):
    def setUp(self):
        super().setUp()
        self.sources.ebooks = [ebook(1, "A Game of Thrones", "George R. R. Martin")]
        self.sources.audiobooks = [audiobook("10:1", "A Song of Ice and Fire", "George R. R. Martin")]
        self.rebuild()
        self.e_id = self.live()[(1, None)]
        self.a_id = self.live()[(None, "10:1")]

    def test_a_pair_forming_keeps_the_audiobook_row_and_merges_the_ebook_row(self):
        self.override(1, "10:1", "pair")
        self.rebuild()
        self.assertEqual(self.live(), {(1, "10:1"): self.a_id})
        ghost = self.book(self.e_id)
        self.assertEqual(ghost.merged_into, self.a_id)

    def test_a_split_revives_the_old_row_and_the_audiobook_keeps_its_own(self):
        self.override(1, "10:1", "pair")
        self.rebuild()
        self.override(1, "10:1", "apart")
        self.rebuild()
        self.assertEqual(self.live(), {(1, None): self.e_id, (None, "10:1"): self.a_id})
        self.assertIsNone(self.book(self.e_id).merged_into)
        self.assertIsNone(self.book(self.a_id).kavita_chapter_id)

    def test_a_split_of_a_pair_that_was_never_two_rows_makes_a_new_row_for_the_ebook(self):
        self.sources.ebooks = [ebook(2, "Dune")]
        self.sources.audiobooks = [audiobook("20:1", "Dune")]
        self.rebuild()
        joined = self.live()[(2, "20:1")]
        self.override(2, "20:1", "apart")
        self.rebuild()
        live = self.live()
        self.assertEqual(live[(None, "20:1")], joined)
        self.assertNotIn(live[(2, None)], (joined, self.e_id, self.a_id))

    def test_every_old_id_still_reaches_a_live_book_after_each_change(self):
        for step in ("pair", "apart", "pair"):
            self.override(1, "10:1", step)
            self.rebuild()
            live_ids = set(self.live().values())
            for old in (self.e_id, self.a_id):
                row = self.book(old)
                self.assertTrue(row.merged_into is None or row.merged_into in live_ids, (step, old))

    def test_the_audiobook_going_leaves_the_ebook_the_pairs_row(self):
        self.override(1, "10:1", "pair")
        self.rebuild()
        self.sources.audiobooks = []
        self.rebuild()
        self.assertEqual(self.live(), {(1, None): self.a_id})
        self.assertEqual(self.book(self.e_id).merged_into, self.a_id)

    def test_an_ebook_joining_an_audiobook_that_already_has_a_row_merges_its_row_in(self):
        self.sources.ebooks.append(ebook(2, "Dune"))
        self.rebuild()
        dune_e = self.live()[(2, None)]
        self.sources.audiobooks.append(audiobook("20:1", "Dune"))
        self.rebuild()
        dune_a = self.live()[(2, "20:1")]
        self.assertNotEqual(dune_e, dune_a)
        self.assertEqual(self.book(dune_e).merged_into, dune_a)

    def test_a_ghost_whose_book_is_gone_goes_with_it(self):
        self.override(1, "10:1", "pair")
        self.rebuild()
        self.sources.ebooks = []
        self.sources.audiobooks = []
        self.rebuild()
        self.assertEqual(self.live(), {})
        db = self.db()
        try:
            self.assertEqual(db.query(book_catalog.Book).count(), 0)
        finally:
            db.close()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Lock(CatalogCase):
    def test_a_rebuild_while_another_holds_the_lock_is_skipped(self):
        self.sources.ebooks = [ebook(1, "Dune")]

        async def scenario():
            from app.services.notification_poller import LeaderLease
            import redis.asyncio as aioredis
            r = aioredis.from_url(settings.redis_url)
            held = LeaderLease(r, key=book_catalog.LOCK_KEY, ttl=30)
            try:
                self.assertTrue(await held.refresh())
                status = await book_catalog.catalog_status()
                out = await book_catalog.rebuild("test")
                await held.release()
                return status, out
            finally:
                await r.aclose()

        status, out = asyncio.run(scenario())
        self.assertTrue(status["running"])
        self.assertTrue(out["skipped"])
        self.assertEqual(self.live(), {})            # nothing ran
        self.assertFalse(self.rebuild()["skipped"])  # and it is free again

    def test_two_processes_rebuilding_at_once_run_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            url = f"sqlite:///{tmp}/catalog.db"
            subprocess.run([sys.executable, "-c", PREPARE, url], cwd=ROOT, check=True, timeout=120)
            results = run_together([REBUILD_CHILD, REBUILD_CHILD], url)
        self.assertEqual(sorted(r["skipped"] for r in results), [False, True])
        ran = next(r for r in results if not r["skipped"])
        self.assertEqual((ran["ok"], ran["books"]), (True, 0))


PREPARE = """
import sys
from app.database import Base, make_engine
from app import models
Base.metadata.create_all(bind=make_engine(sys.argv[1]))
"""

# Each child waits for the parent's "go" so both start at the same moment,
# then rebuilds with Kavita slow enough for the other to arrive while the lock
# is held.
REBUILD_CHILD = """
import asyncio, json, sys
import app.tests
from app.integrations import kavita, plex_player
from app.services import book_catalog

async def slow_kavita():
    await asyncio.sleep(3)
    return []

async def no_books():
    return []

kavita.list_books = slow_kavita
plex_player.catalog_books = no_books
print("ready", flush=True)
sys.stdin.readline()
print(json.dumps(asyncio.run(book_catalog.rebuild("test"))), flush=True)
"""

# The start-up of one worker: what the app runs in its lifespan.
STARTUP_CHILD = """
import sys
import app.tests
from app.database import init_db
print("ready", flush=True)
sys.stdin.readline()
init_db()
print("started", flush=True)
"""


def run_together(scripts, database_url):
    """Start the scripts as separate Python processes on one SQLite file, let
    each finish its imports, release them together and return what each
    printed last (JSON when it parses)."""
    env = {**os.environ, "DATABASE_URL": database_url}
    procs = [subprocess.Popen([sys.executable, "-c", s], cwd=ROOT, env=env, stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for s in scripts]
    try:
        for p in procs:
            assert p.stdout.readline().strip() == "ready", p.stderr.read()
        for p in procs:
            p.stdin.write("go\n")
            p.stdin.flush()
        results = []
        for p in procs:
            out, err = p.communicate(timeout=120)
            assert p.returncode == 0, err
            last = out.strip().splitlines()[-1]
            try:
                results.append(json.loads(last))
            except ValueError:
                results.append(last)
        return results
    finally:
        for p in procs:
            if p.poll() is None:
                p.kill()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Migration(unittest.TestCase):
    def test_two_workers_starting_at_once_on_a_database_from_before_the_catalog(self):
        from sqlalchemy import inspect, text

        from app import models  # noqa: F401 - registers the tables
        from app.database import Base, make_engine

        new_tables = {"books", "book_pair_overrides", "book_catalog_meta"}
        with tempfile.TemporaryDirectory() as tmp:
            url = f"sqlite:///{tmp}/old.db"
            engine = make_engine(url)
            Base.metadata.create_all(bind=engine, tables=[t for t in Base.metadata.sorted_tables
                                                          if t.name not in new_tables])
            with engine.begin() as conn:
                conn.execute(text("INSERT INTO settings (key, value) VALUES ('branding.app_name', 'Kept')"))
            self.assertFalse(new_tables & set(inspect(engine).get_table_names()))

            outcomes = run_together([STARTUP_CHILD, STARTUP_CHILD], url)
            self.assertEqual(outcomes, ["started", "started"])
            run_together([STARTUP_CHILD], url)             # and a start on the migrated database

            self.assertTrue(new_tables <= set(inspect(engine).get_table_names()))
            with engine.connect() as conn:
                kept = conn.execute(text("SELECT value FROM settings WHERE key = 'branding.app_name'")).scalar()
            engine.dispose()
        self.assertEqual(kept, "Kept")


    def test_two_workers_remake_catalog_tables_that_were_keyed_on_a_series(self):
        from sqlalchemy import inspect, text

        from app import models  # noqa: F401 - registers the tables
        from app.database import Base, make_engine

        with tempfile.TemporaryDirectory() as tmp:
            url = f"sqlite:///{tmp}/old.db"
            engine = make_engine(url)
            Base.metadata.create_all(bind=engine, tables=[t for t in Base.metadata.sorted_tables
                                                          if t.name not in ("books", "book_pair_overrides")])
            with engine.begin() as conn:
                conn.execute(text("CREATE TABLE books (id INTEGER PRIMARY KEY, title VARCHAR(300) NOT NULL, "
                                  "kavita_series_id INTEGER)"))
                conn.execute(text("CREATE TABLE book_pair_overrides (id INTEGER PRIMARY KEY, "
                                  "kavita_series_id INTEGER NOT NULL, plex_book_key VARCHAR(64) NOT NULL)"))

            self.assertEqual(run_together([STARTUP_CHILD, STARTUP_CHILD], url), ["started", "started"])
            columns = {t: {c["name"] for c in inspect(engine).get_columns(t)}
                       for t in ("books", "book_pair_overrides")}
            self.assertLessEqual({"kavita_chapter_id", "kavita_volume_id", "kavita_series_id"}, columns["books"])
            self.assertIn("kavita_chapter_id", columns["book_pair_overrides"])
            self.assertNotIn("kavita_series_id", columns["book_pair_overrides"])

            now = "2026-01-01 00:00:00"
            with engine.begin() as conn:
                conn.execute(text("INSERT INTO books (title, sort_title, author, narrator, series, description, "
                                  "cover_source, updated_at, kavita_chapter_id) "
                                  f"VALUES ('Kept', '', '', '', '', '', 'kavita', '{now}', 7)"))
            run_together([STARTUP_CHILD], url)             # a later start leaves the new tables alone
            with engine.connect() as conn:
                kept = conn.execute(text("SELECT title FROM books WHERE kavita_chapter_id = 7")).scalar()
            engine.dispose()
        self.assertEqual(kept, "Kept")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Webhook(unittest.TestCase):
    SECRET = "s3cret-for-the-test"

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        db = self.Session()
        helpers.put(db, "integration.chaptarr.webhook_secret", self.SECRET)
        db.close()
        patcher = mock.patch("app.integrations.config.SessionLocal", self.Session)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = helpers.api_client(self.Session)
        self.addCleanup(helpers.reset_overrides)
        self.rebuild = mock.AsyncMock(return_value={"ok": True})
        patcher = mock.patch("app.routers.chaptarr_webhook.book_catalog.rebuild", self.rebuild)
        patcher.start()
        self.addCleanup(patcher.stop)

    def post(self, body, password=SECRET, user="chaptarr", raw=None):
        headers = {}
        if password is not None:
            token = base64.b64encode(f"{user}:{password}".encode()).decode()
            headers["Authorization"] = f"Basic {token}"
        if raw is not None:
            return self.client.post("/api/webhooks/chaptarr", content=raw, headers=headers)
        return self.client.post("/api/webhooks/chaptarr", json=body, headers=headers)

    def test_a_wrong_secret_is_401_and_nothing_runs(self):
        self.assertEqual(self.post({"eventType": "Download"}, password="nope").status_code, 401)
        self.assertEqual(self.post({"eventType": "Download"}, password=self.SECRET + "x").status_code, 401)
        self.assertEqual(self.post({"eventType": "Download"}, password=None).status_code, 401)
        self.rebuild.assert_not_awaited()

    def test_a_basic_header_of_another_shape_is_401(self):
        for header in ("Basic !!!not-base64!!!", "Bearer " + self.SECRET, "Basic "):
            r = self.client.post("/api/webhooks/chaptarr", json={"eventType": "Download"},
                                 headers={"Authorization": header})
            self.assertEqual(r.status_code, 401, header)
        self.rebuild.assert_not_awaited()

    def test_an_empty_secret_setting_refuses_everyone(self):
        db = self.Session()
        helpers.put(db, "integration.chaptarr.webhook_secret", "")
        db.close()
        self.assertEqual(self.post({"eventType": "Download"}, password="").status_code, 401)
        self.assertEqual(self.post({"eventType": "Download"}, password=None).status_code, 401)
        self.rebuild.assert_not_awaited()

    def test_an_unknown_event_is_204_and_nothing_runs(self):
        for event in ({"eventType": "Test"}, {"eventType": "Grab"}, {"eventType": "Rename"}, {"eventType": 5},
                      {"other": 1}, [1, 2]):
            with self.subTest(event=event):
                r = self.post(event)
                self.assertEqual(r.status_code, 204)
                self.assertEqual(r.content, b"")
        self.rebuild.assert_not_awaited()

    def test_an_import_event_triggers_a_rebuild(self):
        r = self.post({"eventType": "Download", "book": {"title": "Dune"}}, user="anything")
        self.assertEqual(r.status_code, 202)
        self.rebuild.assert_awaited_once_with("chaptarr")

    def test_a_failing_rebuild_does_not_fail_the_webhook(self):
        self.rebuild.side_effect = RuntimeError("database is locked")
        self.assertEqual(self.post({"eventType": "Download"}).status_code, 202)

    def test_a_body_that_is_not_json_is_400(self):
        self.assertEqual(self.post(None, raw=b"not json").status_code, 400)
        self.rebuild.assert_not_awaited()


class Volumes(CatalogCase):
    """The ebook unit is one book, not a Kavita series."""

    def test_each_volume_of_a_series_pairs_with_its_own_audiobook(self):
        martin = "George R. R. Martin"
        self.sources.ebooks = [
            ebook(11, "A Game of Thrones", martin, series="A Song of Ice and Fire", series_number=1,
                  series_id=1, volume_id=10),
            ebook(21, "A Clash of Kings", martin, series="A Song of Ice and Fire", series_number=2,
                  series_id=1, volume_id=20),
        ]
        self.sources.audiobooks = [audiobook("50:1", "A Game of Thrones", martin),
                                   audiobook("60:1", "A Clash of Kings", martin)]
        out = self.rebuild()
        self.assertEqual((out["ebooks"], out["audiobooks"], out["books"]), (2, 2, 2))
        self.assertEqual(set(self.live()), {(11, "50:1"), (21, "60:1")})
        row = self.book(self.live()[(21, "60:1")])
        self.assertEqual((row.kavita_series_id, row.kavita_volume_id, row.kavita_library_id), (1, 20, 1))
        self.assertEqual((row.series, row.series_number), ("A Song of Ice and Fire", 2))

    def test_volumes_with_no_audiobook_stay_separate_ebooks_of_one_series(self):
        self.sources.ebooks = [ebook(11, "Book One", series="Saga", series_number=1, series_id=1, volume_id=10),
                               ebook(21, "Book Two", series="Saga", series_number=2, series_id=1, volume_id=20)]
        self.assertEqual(self.rebuild()["books"], 2)
        self.assertEqual({r.series_number for r in map(self.book, self.live().values())}, {1, 2})

    def test_an_override_names_one_volume_not_its_series(self):
        self.sources.ebooks = [ebook(11, "Book One", series_id=1, volume_id=10),
                               ebook(21, "Book Two", series_id=1, volume_id=20)]
        self.sources.audiobooks = [audiobook("50:1", "Something Else")]
        self.override(21, "50:1", "pair")
        self.rebuild()
        self.assertEqual(set(self.live()), {(11, None), (21, "50:1")})

    def test_a_standalone_book_is_not_a_series(self):
        self.sources.ebooks = [ebook(5, "Catch-22", "Joseph Heller")]
        self.rebuild()
        row = self.book(next(iter(self.live().values())))
        self.assertEqual((row.series, row.series_number, row.kavita_volume_id), ("", None, None))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class KavitaRead(unittest.TestCase):
    """kavita.list_books against a fake Kavita holding the shapes the real one does:
    a multi-volume series, a single-volume series, standalone books kept as
    specials and loose chapters, and authors as Kavita stores them."""
    KEY = "kavita-key-for-the-test"

    def setUp(self):
        self.requests = []

        def chapter(cid, title, writers, created="2026-08-14T22:52:23.5081475", summary=""):
            return {"id": cid, "titleName": title, "createdUtc": created, "summary": summary,
                    "writers": [{"name": w} for w in writers]}

        self.series = [
            {"id": 1, "name": "A Song of Ice and Fire", "libraryId": 1},
            {"id": 2, "name": "Catch-22", "libraryId": 1},
            {"id": 3, "name": "Throne of Glass", "libraryId": 2},
            {"id": 4, "name": "Odds and Ends", "libraryId": 1},
            {"id": 5, "name": "Harry Potter 03", "libraryId": 1},
        ]
        self.detail = {
            1: {"volumes": [
                {"id": 10, "name": "A Game of Thrones", "minNumber": 1, "chapters": [{"id": 11}]},
                {"id": 20, "name": "A Clash of Kings", "minNumber": 2, "chapters": [{"id": 21}, {"id": 22}]}]},
            2: {"volumes": [{"id": 30, "name": "1", "minNumber": 1, "chapters": [{"id": 31}]}]},
            3: {"volumes": [], "specials": [{"id": 41}]},
            4: {"volumes": [{"id": 50, "name": "Loose", "minNumber": -100000, "chapters": [{"id": 51}]}],
                "chapters": [{"id": 52}, {"id": 53}], "storylineChapters": [{"id": 52}], "specials": []},
            5: {"volumes": [], "specials": [{"id": 61}]},
        }
        self.chapters = {
            11: chapter(11, "A Game of Thrones", ["George R. R. Martin"], summary="A <b>big</b> book.<br>Winter &amp; war."),
            21: chapter(21, "A Clash of Kings", ["George R. R. Martin"]),
            22: chapter(22, "Never read", ["Someone"]),
            31: chapter(31, "Catch-22", ["Joseph Heller"]),
            41: chapter(41, "Throne of Glass", ["Maas", "Sarah J."]),
            51: chapter(51, "Loose One", ["Ann Author"]),
            52: chapter(52, "Loose Two", ["Ann Author"]),
            53: chapter(53, "Loose Three", ["Ann Author", "Bo Co"], created="bad"),
            61: chapter(61, "Harry Potter and the Prisoner of Azkaban", ["authors_sort"]),
        }
        self.series_writers = {5: ["authors_sort", "J. K. Rowling"]}
        self.answers = {"authenticate": 200, "series": 200}
        self.real_client = httpx.AsyncClient
        for p in (mock.patch.object(kavita.integration_config, "read", self.read_settings),
                  mock.patch.object(kavita.httpx, "AsyncClient", self.client)):
            p.start()
            self.addCleanup(p.stop)
        self.settings = {kavita.URL_KEY: "http://kavita.test:5000/", kavita.API_KEY: self.KEY}

    def read_settings(self, keys):
        return {k: self.settings.get(k) for k in keys}

    def client(self, **kwargs):
        return self.real_client(transport=httpx.MockTransport(self.handle))

    def handle(self, request):
        self.requests.append(request)
        path, params = request.url.path, request.url.params
        if path == "/api/Plugin/authenticate":
            if self.answers["authenticate"] != 200 or params.get("apiKey") != self.KEY:
                return httpx.Response(401)
            return httpx.Response(200, json={"token": "jwt"})
        if request.headers.get("authorization") != "Bearer jwt":
            return httpx.Response(401)
        if path == "/api/Series/all-v2":
            if self.answers["series"] != 200:
                return httpx.Response(self.answers["series"])
            return httpx.Response(200, json=self.series,
                                  headers={"Pagination": json.dumps({"currentPage": 1, "totalPages": 1})})
        if path == "/api/Series/series-detail":
            return httpx.Response(200, json=self.detail[int(params["seriesId"])])
        if path == "/api/Series/chapter":
            return httpx.Response(200, json=self.chapters[int(params["chapterId"])])
        if path == "/api/Series/metadata":
            return httpx.Response(200, json={"writers": [{"name": w} for w in
                                                         self.series_writers.get(int(params["seriesId"]), [])]})
        return httpx.Response(404)

    def read(self):
        return {b["id"]: b for b in asyncio.run(kavita.list_books())}

    def test_a_multi_volume_series_is_one_book_per_volume(self):
        books = self.read()
        got, clash = books[11], books[21]
        self.assertEqual((got["title"], got["series"], got["series_number"]), ("A Game of Thrones", "A Song of Ice and Fire", 1))
        self.assertEqual((got["series_id"], got["volume_id"], got["library_id"]), (1, 10, 1))
        self.assertEqual((clash["title"], clash["series_number"], clash["volume_id"]), ("A Clash of Kings", 2, 20))
        self.assertNotIn(1, books)                         # the series itself is not a book
        self.assertNotIn(22, books)                        # a volume's second file is part of the same book

    def test_a_single_volume_series_stays_one_book_and_is_not_a_series(self):
        book = self.read()[31]
        self.assertEqual((book["title"], book["series"], book["series_number"], book["volume_id"]),
                         ("Catch-22", "", 1, 30))

    def test_a_standalone_book_kept_as_a_special_is_a_book_by_its_chapter(self):
        book = self.read()[41]
        self.assertEqual((book["title"], book["volume_id"], book["series_number"], book["library_id"]),
                         ("Throne of Glass", None, None, 2))
        self.assertEqual(book["series_id"], 3)

    def test_loose_chapters_are_one_book_each_without_duplicates(self):
        books = self.read()
        self.assertEqual([books[i]["title"] for i in (51, 52, 53)], ["Loose One", "Loose Two", "Loose Three"])
        self.assertTrue(all(books[i]["volume_id"] is None and books[i]["series_number"] is None for i in (51, 52, 53)))
        self.assertEqual(len([b for b in books.values() if b["series_id"] == 4]), 3)

    def test_authors_are_the_books_writers(self):
        books = self.read()
        self.assertEqual(books[11]["author"], "George R. R. Martin")
        self.assertEqual(books[53]["author"], "Ann Author")             # the first of two writers
        self.assertEqual(books[41]["author"], "Sarah J. Maas")          # "Maas, Sarah J." split by Kavita

    def test_a_placeholder_writer_is_not_an_author_and_the_series_writer_stands_in(self):
        self.assertEqual(self.read()[61]["author"], "J. K. Rowling")
        self.series_writers = {5: ["authors_sort"]}
        self.assertEqual(self.read()[61]["author"], "")

    def test_the_series_writers_are_read_only_when_a_book_has_none(self):
        self.read()
        asked = [r.url.params["seriesId"] for r in self.requests if r.url.path == "/api/Series/metadata"]
        self.assertEqual(asked, ["5"])

    def test_summary_is_plain_text_and_the_date_is_utc(self):
        book = self.read()[11]
        self.assertEqual(book["description"], "A big book.\nWinter & war.")
        self.assertEqual(book["added_at"], datetime(2026, 8, 14, 22, 52, 23, 508147))
        self.assertIsNone(self.read()[53]["added_at"])

    def test_it_pages_through_a_long_library(self):
        self.series = [{"id": 1, "name": "A Song of Ice and Fire", "libraryId": 1},
                       {"id": 2, "name": "Catch-22", "libraryId": 1}]
        pages = {1: self.series[:1], 2: self.series[1:]}
        original = self.handle

        def paged(request):
            if request.url.path == "/api/Series/all-v2":
                page = int(request.url.params["PageNumber"])
                return httpx.Response(200, json=pages[page],
                                      headers={"Pagination": json.dumps({"currentPage": page, "totalPages": 2})})
            return original(request)

        self.handle = paged
        self.assertEqual(set(self.read()), {11, 21, 31})

    def test_a_refused_key_says_so_without_the_key(self):
        self.answers["authenticate"] = 401
        with self.assertRaises(kavita.KavitaUnavailable) as ctx:
            self.read()
        self.assertEqual(str(ctx.exception), "Kavita refused the API key")
        self.assertNotIn(self.KEY, str(ctx.exception))

    def test_kavita_down_says_so_without_the_address_or_key(self):
        def down(request):
            raise httpx.ConnectError("connect failed for http://kavita.test:5000/?apiKey=" + self.KEY)
        self.handle = down
        with self.assertRaises(kavita.KavitaUnavailable) as ctx:
            self.read()
        self.assertEqual(str(ctx.exception), "Kavita did not answer")

    def test_a_server_error_is_unavailable(self):
        self.answers["series"] = 503
        with self.assertRaises(kavita.KavitaUnavailable) as ctx:
            self.read()
        self.assertEqual(str(ctx.exception), "Kavita answered HTTP 503")

    def test_a_failure_part_way_through_is_unavailable_not_a_partial_library(self):
        original = self.handle

        def broken(request):
            if request.url.path == "/api/Series/chapter" and request.url.params["chapterId"] == "31":
                return httpx.Response(500)
            return original(request)

        self.handle = broken
        with self.assertRaises(kavita.KavitaUnavailable):
            self.read()

    def test_missing_settings_are_named(self):
        for settings_, message in (({}, "Kavita is not set up"),
                                   ({kavita.URL_KEY: "http://kavita.test:5000"}, "Add the Kavita API key")):
            with self.subTest(message=message):
                self.settings = settings_
                with self.assertRaises(kavita.KavitaUnavailable) as ctx:
                    self.read()
                self.assertEqual(str(ctx.exception), message)
                self.assertEqual(self.requests, [])


if __name__ == "__main__":
    unittest.main()
