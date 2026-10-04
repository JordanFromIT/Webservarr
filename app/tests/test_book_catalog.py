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

    def editions(self, book_id):
        """{plex key: narrator} of the book's audiobook editions."""
        db = self.db()
        try:
            return {e.plex_book_key: e.narrator for e in
                    db.query(book_catalog.BookAudioEdition).filter(book_catalog.BookAudioEdition.book_id == book_id)}
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

    def test_two_ebooks_of_one_key_are_too_uncertain_to_take_the_edition(self):
        self.sources.ebooks = [ebook(1, "Dune"), ebook(2, "Dune")]
        self.sources.audiobooks = [audiobook("10:1", "Dune")]
        self.rebuild()
        self.assertEqual(set(self.live()), {(1, None), (2, None), (None, "10:1")})

    def test_a_book_kept_as_a_series_of_its_own_takes_a_series_prefix_its_neighbours_name(self):
        rowling = "J. K. Rowling"
        self.sources.ebooks = [
            ebook(1, "Harry Potter 03 - Harry Potter and the Prisoner of Azkaban", rowling, series=""),
            ebook(2, "Harry Potter and the Chamber of Secrets", rowling, series="Harry Potter", series_number=2),
        ]
        self.sources.audiobooks = [audiobook("10:1", "Harry Potter and the Prisoner of Azkaban", rowling)]
        self.rebuild()
        self.assertEqual(set(self.live()), {(1, "10:1"), (2, None)})

    def test_a_paired_book_shows_the_audiobook_title_and_both_dates(self):
        self.sources.ebooks = [ebook(1, "Dune", description="An ebook summary", added_at=datetime(2026, 8, 1))]
        self.sources.audiobooks = [audiobook("10:1", "Dune", description="", added_at=1_700_000_000)]
        self.rebuild()
        book_id = self.live()[(1, "10:1")]
        row = self.book(book_id)
        self.assertEqual((row.title, row.description), ("Dune", "An ebook summary"))
        self.assertEqual(self.editions(book_id), {"10:1": "Scott Brick"})
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

    def test_a_new_pair_for_the_same_edition_replaces_the_old_one(self):
        self.override(1, "10:1", "pair")
        self.override(2, "10:1", "pair")      # the edition moves to the other ebook
        db = self.db()
        try:
            rows = [(o.kavita_chapter_id, o.plex_book_key, o.action)
                    for o in db.query(book_catalog.BookPairOverride).all()]
        finally:
            db.close()
        self.assertEqual(rows, [(2, "10:1", "pair")])
        self.rebuild()
        live = self.live()
        self.assertIn((1, None), live)
        self.assertEqual(set(self.editions(live[(2, "10:1")])), {"10:1", "20:1"})

    def test_an_ebook_can_be_paired_with_several_editions(self):
        self.sources.audiobooks.append(audiobook("30:1", "Another Title", "George R. R. Martin"))
        self.override(1, "10:1", "pair")
        self.override(1, "30:1", "pair")
        self.rebuild()
        live = self.live()
        self.assertEqual(set(self.editions(live[(1, "10:1")])), {"10:1", "30:1"})
        self.assertEqual(len(live), 2)

    def test_a_stale_second_pair_in_the_table_loses_to_the_newer_one(self):
        db = self.db()
        try:
            db.add_all([
                book_catalog.BookPairOverride(kavita_chapter_id=1, plex_book_key="10:1", action="pair",
                                              created_by="a", created_at=datetime(2026, 1, 1)),
                book_catalog.BookPairOverride(kavita_chapter_id=2, plex_book_key="10:1", action="pair",
                                              created_by="a", created_at=datetime(2026, 2, 1)),
            ])
            db.commit()
        finally:
            db.close()
        self.rebuild()
        live = self.live()
        self.assertIn((1, None), live)
        self.assertEqual(set(self.editions(live[(2, "10:1")])), {"10:1", "20:1"})

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

    def test_a_new_audiobook_waits_for_an_ebook_held_from_a_failed_read(self):
        self.sources.kavita_down = True
        self.sources.audiobooks.append(audiobook("50:1", "Emma", "Jane Austen"))
        self.rebuild()
        live = self.live()
        self.assertEqual(live[(2, None)], self.before[(2, None)])        # the held ebook stays as it is
        self.assertIn((None, "50:1"), live)
        self.sources.kavita_down = False
        self.rebuild()
        live = self.live()
        self.assertEqual(self.book(self.before[(2, None)]).merged_into, live[(2, "50:1")])   # and pairs once Kavita is back
        self.assertNotIn((None, "50:1"), live)

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
        self.sources.audiobooks.append(audiobook("20:1", "Dune"))
        self.override(2, "20:1", "apart")
        self.rebuild()
        dune_e, dune_a = self.live()[(2, None)], self.live()[(None, "20:1")]
        db = self.db()
        try:
            book_catalog.remove_override(db, 2, "20:1")
        finally:
            db.close()
        self.rebuild()
        self.assertEqual(self.live()[(2, "20:1")], dune_a)           # the audiobook's row is kept
        self.assertEqual(self.book(dune_e).merged_into, dune_a)      # and the ebook's finds it

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


    def test_two_workers_remake_catalog_tables_made_in_an_earlier_shape(self):
        from sqlalchemy import inspect, text

        from app import models  # noqa: F401 - registers the tables
        from app.database import Base, make_engine

        shapes = {
            # the ebook was a whole Kavita series
            "series": ("kavita_series_id INTEGER, narrator VARCHAR(200)", "kavita_series_id INTEGER NOT NULL"),
            # the ebook is one book, but a book holds one audiobook and its narrator
            "one audiobook": ("kavita_chapter_id INTEGER, narrator VARCHAR(200)", "kavita_chapter_id INTEGER NOT NULL"),
            # editions, but no work key of its own on an ebook or an edition
            "no own keys": ("kavita_chapter_id INTEGER, plex_book_key VARCHAR(64)", "kavita_chapter_id INTEGER NOT NULL"),
        }
        for shape, (book_columns, override_key) in shapes.items():
            with self.subTest(shape=shape), tempfile.TemporaryDirectory() as tmp:
                url = f"sqlite:///{tmp}/old.db"
                engine = make_engine(url)
                Base.metadata.create_all(bind=engine, tables=[t for t in Base.metadata.sorted_tables if t.name not in (
                    "books", "book_pair_overrides", "book_audio_editions")])
                with engine.begin() as conn:
                    conn.execute(text(f"CREATE TABLE books (id INTEGER PRIMARY KEY, title VARCHAR(300) NOT NULL, "
                                      f"{book_columns})"))
                    conn.execute(text(f"CREATE TABLE book_pair_overrides (id INTEGER PRIMARY KEY, {override_key}, "
                                      "plex_book_key VARCHAR(64) NOT NULL, action VARCHAR(8) NOT NULL, "
                                      "created_by VARCHAR(255) NOT NULL, created_at DATETIME NOT NULL)"))
                    if shape == "no own keys":
                        conn.execute(text("CREATE TABLE book_audio_editions (id INTEGER PRIMARY KEY, "
                                          "book_id INTEGER NOT NULL, plex_book_key VARCHAR(64) NOT NULL UNIQUE, "
                                          "narrator VARCHAR(200) NOT NULL, added_at DATETIME)"))
                    conn.execute(text("INSERT INTO book_pair_overrides VALUES (1, 7, '10:1', 'apart', 'a', "
                                      "'2026-01-01 00:00:00')"))

                self.assertEqual(run_together([STARTUP_CHILD, STARTUP_CHILD], url), ["started", "started"])
                tables = set(inspect(engine).get_table_names())
                columns = {t: {c["name"] for c in inspect(engine).get_columns(t)}
                           for t in ("books", "book_pair_overrides")}
                self.assertIn("book_audio_editions", tables)
                self.assertLessEqual({"kavita_chapter_id", "kavita_volume_id", "kavita_series_id", "plex_book_key",
                                       "ebook_work_key"}, columns["books"])
                self.assertIn("work_key", {c["name"] for c in inspect(engine).get_columns("book_audio_editions")})
                self.assertNotIn("narrator", columns["books"])
                self.assertIn("kavita_chapter_id", columns["book_pair_overrides"])

                with engine.begin() as conn:
                    conn.execute(text("INSERT INTO books (title, sort_title, author, series, description, "
                                      "cover_source, updated_at, kavita_chapter_id) "
                                      "VALUES ('Kept', '', '', '', '', 'kavita', '2026-01-01 00:00:00', 7)"))
                run_together([STARTUP_CHILD], url)             # a later start leaves the new tables alone
                with engine.connect() as conn:
                    kept = conn.execute(text("SELECT title FROM books WHERE kavita_chapter_id = 7")).scalar()
                    overrides = conn.execute(text("SELECT COUNT(*) FROM book_pair_overrides")).scalar()
                engine.dispose()
                self.assertEqual(kept, "Kept")
                # An override already keyed on the chapter survives; one keyed on a series can't mean anything.
                self.assertEqual(overrides, 0 if shape == "series" else 1)


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
        # FR3: the scan, the two claims (one Redis each, as the two workers share them) and the waits are fakes.
        self.scan = mock.AsyncMock(return_value=1)
        self.sleeps = []
        self.claimed = set()
        self.redis_up = True

        async def claim(key, seconds):
            self.claim_log.append((key, seconds))
            if not self.redis_up or key in self.claimed:
                return False
            self.claimed.add(key)
            return True

        async def sleep(seconds):
            self.sleeps.append(seconds)
        self.claim_log = []
        from app.routers import chaptarr_webhook
        self.real_claim = chaptarr_webhook._claim
        for target, value in (("app.routers.chaptarr_webhook.kavita.scan_libraries", self.scan),
                              ("app.routers.chaptarr_webhook._claim", claim),
                              ("app.routers.chaptarr_webhook.asyncio.sleep", sleep)):
            patcher = mock.patch(target, value)
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
        self.rebuild.assert_awaited_with("chaptarr")

    # FR3: Kavita only looks for new files on its own schedule, so an import asks it to scan
    def test_an_import_asks_kavita_to_scan_and_rebuilds_now_and_twice_after(self):
        self.assertEqual(self.post({"eventType": "Download"}).status_code, 202)
        self.scan.assert_awaited_once_with()
        self.assertEqual(self.rebuild.await_count, 3)              # at once, then after the scan
        self.assertEqual(self.sleeps, [20, 100])                   # 20 s after the scan, and 120 s after it
        self.assertEqual(sorted(self.claimed), ["books:kavita-scan", "books:post-import"])
        self.assertEqual(dict(self.claim_log), {"books:kavita-scan": 30, "books:post-import": 150})

    def test_the_scan_is_asked_before_the_waits_and_the_first_rebuild_does_not_wait_for_it(self):
        order = []
        self.rebuild.side_effect = lambda reason: order.append("rebuild")
        self.scan.side_effect = lambda: order.append("scan")
        self.post({"eventType": "Download"})
        self.assertEqual(order, ["rebuild", "scan", "rebuild", "rebuild"])

    def test_a_burst_of_imports_is_bounded(self):
        for _ in range(5):
            self.assertEqual(self.post({"eventType": "Download"}).status_code, 202)
        self.assertEqual(self.scan.await_count, 1)                 # one scan request for the burst
        self.assertEqual(self.sleeps, [20, 100])                   # one follow-up sequence
        self.assertEqual(self.rebuild.await_count, 3 + 4)          # every import still rebuilds at once

    def test_an_import_after_the_scan_gap_asks_again_but_starts_no_second_sequence(self):
        self.post({"eventType": "Download"})
        self.claimed.discard("books:kavita-scan")                  # 30 s later; the sequence (150 s) is still running
        self.post({"eventType": "Download"})
        self.assertEqual(self.scan.await_count, 2)
        self.assertEqual(self.sleeps, [20, 100])
        self.claimed.clear()                                       # a long time later: both are free again
        self.post({"eventType": "Download"})
        self.assertEqual(self.scan.await_count, 3)
        self.assertEqual(self.sleeps, [20, 100, 20, 100])

    def test_with_redis_unreachable_only_the_immediate_rebuild_runs(self):
        self.redis_up = False
        self.assertEqual(self.post({"eventType": "Download"}).status_code, 202)
        self.rebuild.assert_awaited_once_with("chaptarr")
        self.scan.assert_not_awaited()
        self.assertEqual(self.sleeps, [])

    def test_a_scan_that_fails_does_not_stop_the_rebuilds_or_fail_the_webhook(self):
        from app.integrations import kavita
        for failure in (kavita.KavitaUnavailable("Kavita did not answer"), RuntimeError("boom")):
            self.scan.side_effect = failure
            self.claimed.clear()
            self.sleeps.clear()
            self.rebuild.reset_mock()
            self.assertEqual(self.post({"eventType": "Download"}).status_code, 202)
            self.assertEqual(self.rebuild.await_count, 3)
            self.assertEqual(self.sleeps, [20, 100])

    def test_a_rebuild_that_fails_does_not_stop_the_scan_or_the_later_rebuilds(self):
        self.rebuild.side_effect = RuntimeError("database is locked")
        self.assertEqual(self.post({"eventType": "Download"}).status_code, 202)
        self.scan.assert_awaited_once_with()
        self.assertEqual(self.rebuild.await_count, 3)

    def test_other_events_ask_nothing_of_kavita(self):
        self.post({"eventType": "Test"})
        self.post({"eventType": "Grab"})
        self.scan.assert_not_awaited()
        self.assertEqual(self.claim_log, [])

    def test_the_answer_is_not_held_up_by_any_of_it(self):
        import inspect
        from app.routers import chaptarr_webhook
        src = inspect.getsource(chaptarr_webhook.chaptarr_import)
        self.assertIn("background.add_task(_after_import)", src)
        for word in ("sleep", "scan", "rebuild(", "_claim"):
            self.assertNotIn(word, src.replace("_after_import", ""))
        module = inspect.getsource(chaptarr_webhook)
        self.assertNotRegex(module, r"(?m)^_?[a-z_]+\s*(:\s*[\w\[\], ]+)?=\s*(\{|\[|set\(|dict\()")      # no module-level store
        self.assertNotRegex(module, r"\bglobal\b")

    def test_the_claim_is_one_set_nx_with_an_expiry_and_fails_closed(self):
        from app.routers import chaptarr_webhook
        calls = []

        class Redis:
            async def set(self, key, value, nx=False, ex=None):
                calls.append((key, nx, ex))
                return True if len(calls) == 1 else None

            async def aclose(self):
                calls.append("closed")

        with mock.patch.object(chaptarr_webhook.aioredis, "from_url", return_value=Redis()):
            self.assertTrue(asyncio.run(self.real_claim("k", 30)))
            self.assertFalse(asyncio.run(self.real_claim("k", 30)))
        self.assertEqual(calls, [("k", True, 30), "closed", ("k", True, 30), "closed"])
        with mock.patch.object(chaptarr_webhook.aioredis, "from_url", side_effect=OSError("down")):
            self.assertFalse(asyncio.run(self.real_claim("k", 30)))

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


class Editions(CatalogCase):
    """A work narrated more than once is one book with several editions."""

    def setUp(self):
        super().setUp()
        self.brick = audiobook("10:1", "Dune", narrator="Scott Brick")
        self.vance = audiobook("11:1", "Dune", narrator="Simon Vance", added_at=1_800_000_000)

    def test_an_ebook_takes_every_edition_with_its_work_key(self):
        self.sources.ebooks = [ebook(1, "Dune")]
        self.sources.audiobooks = [self.brick, self.vance]
        out = self.rebuild()
        self.assertEqual((out["ebooks"], out["audiobooks"], out["books"]), (1, 2, 1))
        live = self.live()
        self.assertEqual(self.editions(live[(1, "10:1")]),
                         {"10:1": "Scott Brick", "11:1": "Simon Vance"})
        self.assertEqual(self.book(live[(1, "10:1")]).audio_added_at, datetime(2023, 11, 14, 22, 13, 20))

    def test_editions_with_no_ebook_and_one_work_key_are_one_book(self):
        self.sources.audiobooks = [self.brick, self.vance, audiobook("12:1", "Emma", "Jane Austen")]
        out = self.rebuild()
        self.assertEqual((out["audiobooks"], out["books"]), (3, 2))
        live = self.live()
        self.assertEqual(set(self.editions(live[(None, "10:1")])), {"10:1", "11:1"})
        self.assertEqual(set(self.editions(live[(None, "12:1")])), {"12:1"})

    def test_a_new_edition_joins_its_book_and_the_book_keeps_its_id(self):
        self.sources.ebooks = [ebook(1, "Dune")]
        self.sources.audiobooks = [self.brick]
        self.rebuild()
        book_id = self.live()[(1, "10:1")]
        self.sources.audiobooks = [self.brick, self.vance]
        self.rebuild()
        self.assertEqual(self.live(), {(1, "10:1"): book_id})
        self.assertEqual(set(self.editions(book_id)), {"10:1", "11:1"})

    def test_an_edition_going_leaves_the_book_and_its_id(self):
        self.sources.ebooks = [ebook(1, "Dune")]
        self.sources.audiobooks = [self.brick, self.vance]
        self.rebuild()
        book_id = self.live()[(1, "10:1")]
        self.sources.audiobooks = [self.vance]
        self.rebuild()
        self.assertEqual(self.live(), {(1, "11:1"): book_id})
        self.assertEqual(set(self.editions(book_id)), {"11:1"})

    def test_the_first_editions_of_a_book_with_only_an_ebook_get_a_row_of_their_own_and_the_old_id_redirects(self):
        self.sources.ebooks = [ebook(1, "Dune")]
        self.rebuild()
        ebook_id = self.live()[(1, None)]
        self.sources.audiobooks = [self.brick, self.vance]
        self.rebuild()
        book_id = self.live()[(1, "10:1")]
        self.assertNotEqual(book_id, ebook_id)
        self.assertEqual(self.book(ebook_id).merged_into, book_id)

    def test_an_apart_override_keeps_one_edition_out_and_removing_it_brings_it_back(self):
        self.sources.ebooks = [ebook(1, "Dune")]
        self.sources.audiobooks = [self.brick, self.vance]
        self.rebuild()
        book_id = self.live()[(1, "10:1")]
        self.override(1, "11:1", "apart")
        self.rebuild()
        live = self.live()
        self.assertEqual(live[(1, "10:1")], book_id)           # the book keeps its row
        vance_id = live[(None, "11:1")]
        self.assertNotEqual(vance_id, book_id)
        self.assertEqual(self.editions(book_id), {"10:1": "Scott Brick"})
        self.assertEqual(self.editions(vance_id), {"11:1": "Simon Vance"})

        db = self.db()
        try:
            book_catalog.remove_override(db, 1, "11:1")
        finally:
            db.close()
        self.rebuild()
        self.assertEqual(self.live(), {(1, "10:1"): book_id})
        self.assertEqual(self.book(vance_id).merged_into, book_id)    # the old id still finds the book
        self.assertEqual(set(self.editions(book_id)), {"10:1", "11:1"})

        self.override(1, "11:1", "apart")                      # and splitting again revives it
        self.rebuild()
        self.assertEqual(self.live(), {(1, "10:1"): book_id, (None, "11:1"): vance_id})
        self.assertIsNone(self.book(vance_id).merged_into)

    def test_a_pair_override_takes_one_edition_only(self):
        self.sources.ebooks = [ebook(1, "A Different Title")]
        self.sources.audiobooks = [self.brick, self.vance]
        self.override(1, "10:1", "pair")
        self.rebuild()
        live = self.live()
        self.assertEqual(self.editions(live[(1, "10:1")]), {"10:1": "Scott Brick"})
        self.assertEqual(self.editions(live[(None, "11:1")]), {"11:1": "Simon Vance"})

    def test_editions_are_held_while_plex_is_down(self):
        self.sources.ebooks = [ebook(1, "Dune")]
        self.sources.audiobooks = [self.brick, self.vance]
        self.rebuild()
        book_id = self.live()[(1, "10:1")]
        self.sources.plex_down = True
        self.sources.audiobooks = []
        out = self.rebuild()
        self.assertEqual((out["audiobooks"], out["books"]), (2, 1))
        self.assertEqual(self.editions(book_id), {"10:1": "Scott Brick", "11:1": "Simon Vance"})

    def test_two_audiobook_books_that_become_one_and_split_again_keep_both_ids(self):
        other = audiobook("20:1", "Dune Messiah")
        self.sources.audiobooks = [self.brick, other]
        self.rebuild()
        first, second = self.live()[(None, "10:1")], self.live()[(None, "20:1")]
        other["work_key"] = self.brick["work_key"]          # the second is found to be a narration of the first
        self.rebuild()
        self.assertEqual(self.live(), {(None, "10:1"): min(first, second)})
        self.assertEqual(self.book(max(first, second)).merged_into, min(first, second))
        other["work_key"] = plex_player.work_key("Frank Herbert", "Dune Messiah", "Scott Brick")
        self.rebuild()
        self.assertEqual(self.live(), {(None, "10:1"): first, (None, "20:1"): second})

    def test_ids_are_stable_over_three_rebuilds_with_editions(self):
        self.sources.ebooks = [ebook(1, "Dune")]
        self.sources.audiobooks = [self.brick, self.vance]
        self.rebuild()
        before = self.live()
        stamps = {b: self.book(b).updated_at for b in before.values()}
        for _ in range(3):
            self.rebuild()
            self.assertEqual(self.live(), before)
        self.assertEqual({b: self.book(b).updated_at for b in before.values()}, stamps)


class SplitKeepsIdentity(CatalogCase):
    """When a book splits, each row goes to the work it is, so an old id never
    opens a different work."""

    def test_removing_a_mistaken_pair_gives_each_work_its_own_id_back(self):
        emma = audiobook("10:1", "Emma", "Jane Austen", narrator="Juliet Stevenson")
        dune_e, dune_a = ebook(1, "Dune"), audiobook("20:1", "Dune")
        self.sources.audiobooks = [emma]
        self.rebuild()
        emma_id = self.live()[(None, "10:1")]
        self.sources.ebooks, self.sources.audiobooks = [dune_e], [emma, dune_a]
        self.rebuild()
        dune_id = self.live()[(1, "20:1")]
        self.override(1, "10:1", "pair")                         # the admin pairs Emma with the Dune ebook by mistake
        self.rebuild()
        self.assertEqual(len(self.live()), 1)
        self.override(1, "10:1", "apart")                        # and takes it back
        self.rebuild()
        self.assertEqual(self.live(), {(None, "10:1"): emma_id, (1, "20:1"): dune_id})
        self.assertEqual(self.book(emma_id).title, "Emma")
        self.assertEqual(self.book(dune_id).title, "Dune")
        self.assertIsNone(self.book(emma_id).merged_into)
        self.assertIsNone(self.book(dune_id).merged_into)

    def test_removing_the_override_instead_of_overriding_apart_gives_the_same_ids_back(self):
        emma = audiobook("10:1", "Emma", "Jane Austen")
        self.sources.ebooks, self.sources.audiobooks = [ebook(1, "Dune")], [emma, audiobook("20:1", "Dune")]
        self.rebuild()
        before = self.live()
        self.override(1, "10:1", "pair")
        self.rebuild()
        db = self.db()
        try:
            book_catalog.remove_override(db, 1, "10:1")
        finally:
            db.close()
        self.rebuild()
        self.assertEqual(self.live(), before)
        for book_id in before.values():
            self.assertIsNone(self.book(book_id).merged_into)

    def test_a_mistagged_album_that_leaves_a_book_does_not_take_its_row(self):
        dune = audiobook("20:1", "Dune", added_at=1_700_000_000)
        self.sources.audiobooks = [dune]
        self.rebuild()
        dune_id = self.live()[(None, "20:1")]
        mistagged = audiobook("10:1", "Dune", narrator="Simon Vance", added_at=1_800_000_000)
        self.sources.audiobooks = [dune, mistagged]
        self.rebuild()
        self.assertEqual(self.live(), {(None, "20:1"): dune_id})        # one book, two editions
        messiah = audiobook("10:1", "Dune Messiah", narrator="Simon Vance", added_at=1_800_000_000)
        self.sources.audiobooks = [dune, messiah]
        self.rebuild()
        live = self.live()
        self.assertEqual(live[(None, "20:1")], dune_id)                 # Dune keeps its id, not the lower key
        self.assertEqual(self.book(dune_id).title, "Dune")
        self.assertEqual(self.editions(dune_id), {"20:1": "Scott Brick"})
        self.assertEqual(self.book(live[(None, "10:1")]).title, "Dune Messiah")

    def test_the_primary_edition_stays_while_it_is_there_even_if_an_earlier_one_joins(self):
        late = audiobook("20:1", "Dune", added_at=1_800_000_000)
        self.sources.audiobooks = [late]
        self.rebuild()
        book_id = self.live()[(None, "20:1")]
        self.sources.audiobooks = [late, audiobook("10:1", "Dune", narrator="Simon Vance", added_at=1_600_000_000)]
        self.rebuild()
        self.assertEqual(self.live(), {(None, "20:1"): book_id})


class Outage(CatalogCase):
    """A source that cannot be read leaves its items exactly where they are: in
    their books, with their text, rebuild after rebuild."""

    def state(self):
        db = self.db()
        try:
            editions = {}
            for e in db.query(book_catalog.BookAudioEdition):
                editions.setdefault(e.book_id, []).append(e.plex_book_key)
            return {b.id: (b.title, b.author, b.kavita_chapter_id, b.plex_book_key, tuple(sorted(editions.get(b.id, []))),
                           b.merged_into, b.kavita_library_id)
                    for b in db.query(book_catalog.Book)}
        finally:
            db.close()

    def paired_with_a_differently_keyed_edition(self):
        dune_e = ebook(1, "Dune", library_id=3, series_id=77)
        full_cast = audiobook("10:1", "Dune: A Full-Cast Dramatisation", narrator="Full Cast", added_at=1_600_000_000)
        brick = audiobook("20:1", "Dune", narrator="Scott Brick", added_at=1_700_000_000)
        self.sources.ebooks, self.sources.audiobooks = [dune_e], [full_cast, brick]
        self.override(1, "10:1", "pair")
        self.rebuild()
        return self.state()

    def test_plex_down_does_not_move_an_edition_that_was_paired_by_override(self):
        before = self.paired_with_a_differently_keyed_edition()
        self.assertEqual(len(self.live()), 1)
        self.sources.plex_down = True
        self.rebuild()
        self.assertEqual(self.state(), before)
        self.sources.plex_down = False
        self.rebuild()
        self.assertEqual(self.state(), before)

    def test_kavita_down_keeps_editions_paired_by_override_in_one_book(self):
        before = self.paired_with_a_differently_keyed_edition()
        for _ in range(3):
            self.sources.kavita_down = True
            self.rebuild()
            self.assertEqual(self.state(), before)
        self.sources.kavita_down = False
        self.rebuild()
        self.assertEqual(self.state(), before)

    def test_an_ebook_held_through_an_outage_is_not_mistaken_for_its_audiobook(self):
        before = self.paired_with_a_differently_keyed_edition()
        book = self.live()[(1, "10:1")]
        self.sources.kavita_down = True
        self.sources.audiobooks = []                       # Plex, up, no longer lists either edition
        self.rebuild()
        self.assertEqual(self.live(), {(1, None): book})   # the ebook, held from Kavita, stands alone
        db = self.db()
        try:
            row = db.get(book_catalog.Book, book)
            self.assertEqual(row.work_key, row.ebook_work_key)
            self.assertEqual(row.ebook_work_key, plex_player.work_key("Frank Herbert", "Dune"))
        finally:
            db.close()
        self.assertEqual(self.state()[book][1], before[book][1])

    def test_an_override_added_during_an_outage_waits_for_it(self):
        self.sources.ebooks = [ebook(1, "Dune", library_id=3, series_id=77)]
        self.sources.audiobooks = [audiobook("20:1", "Dune")]
        self.rebuild()
        before = self.state()
        audio_id = self.live()[(1, "20:1")]
        self.override(1, "20:1", "apart")
        self.sources.kavita_down = True
        self.rebuild()
        after = self.state()
        self.assertEqual(after, before)                    # no "Untitled" ebook, no lost author or library
        self.sources.kavita_down = False
        self.rebuild()
        live = self.live()
        self.assertEqual(live[(None, "20:1")], audio_id)
        self.assertEqual(self.book(live[(1, None)]).title, "Dune")
        self.assertEqual(self.book(live[(1, None)]).kavita_library_id, 3)

    def test_repeated_rebuilds_through_a_plex_outage_change_nothing(self):
        rowling = "J. K. Rowling"
        us = ebook(1, "Harry Potter and the Sorcerer's Stone", rowling)
        fry = audiobook("10:1", "Harry Potter and the Philosopher's Stone", rowling, narrator="Stephen Fry",
                        added_at=1_600_000_000)
        dale = audiobook("20:1", "Harry Potter and the Sorcerer's Stone", rowling, narrator="Jim Dale",
                         added_at=1_700_000_000)
        self.sources.audiobooks = [fry]
        self.rebuild()                                     # Fry's own book first
        self.sources.ebooks, self.sources.audiobooks = [us], [fry, dale]
        self.rebuild()
        self.override(1, "10:1", "pair")                   # the admin pairs Fry with the ebook
        self.sources.plex_down = True
        before = self.state()
        for _ in range(3):
            self.rebuild()
            self.assertEqual(self.state(), before)
        self.sources.plex_down = False
        self.rebuild()
        live = self.live()
        self.assertEqual(len(live), 1)
        self.assertEqual(set(self.editions(next(iter(live.values())))), {"10:1", "20:1"})
        settled = self.state()
        self.rebuild()
        self.assertEqual(self.state(), settled)

    def test_repeated_rebuilds_through_a_kavita_outage_change_nothing(self):
        rowling = "J. K. Rowling"
        us = ebook(1, "Harry Potter and the Sorcerer's Stone", rowling)
        fry = audiobook("10:1", "Harry Potter and the Philosopher's Stone", rowling, narrator="Stephen Fry",
                        added_at=1_600_000_000)
        dale = audiobook("20:1", "Harry Potter and the Sorcerer's Stone", rowling, narrator="Jim Dale",
                         added_at=1_700_000_000)
        self.sources.ebooks, self.sources.audiobooks = [us], [fry, dale]
        self.override(1, "10:1", "pair")
        self.rebuild()
        before = self.state()
        self.assertEqual(len(self.live()), 1)
        self.sources.kavita_down = True
        for _ in range(3):
            self.rebuild()
            self.assertEqual(self.state(), before)
        self.sources.kavita_down = False
        self.rebuild()
        self.assertEqual(self.state(), before)

    def test_a_new_audiobook_waits_for_the_ebook_it_would_pair_with_until_kavita_is_back(self):
        self.sources.ebooks = [ebook(1, "Dune")]
        self.rebuild()
        ebook_row = self.live()[(1, None)]
        self.sources.kavita_down = True
        self.sources.audiobooks = [audiobook("10:1", "Dune"), audiobook("20:1", "Emma", "Jane Austen")]
        self.rebuild()
        self.assertEqual(set(self.live()), {(1, None), (None, "10:1"), (None, "20:1")})
        self.assertEqual(self.live()[(1, None)], ebook_row)
        self.sources.kavita_down = False
        self.rebuild()
        self.assertEqual(set(self.live()), {(1, "10:1"), (None, "20:1")})


class Fuzz(CatalogCase):
    """Random histories: items come and go, are retagged, sources fail and
    come back, overrides are added and removed. After every rebuild the
    catalog must be sound, a second identical rebuild must change nothing, an
    item of a failed source must not move, and an old id must still lead to
    the book that holds what it was first made for."""

    TITLES = ["Dune", "Emma", "Dune Messiah", "Ulysses"]
    AUTHORS = {"Dune": "Frank Herbert", "Dune Messiah": "Frank Herbert", "Emma": "Jane Austen",
               "Ulysses": "James Joyce"}
    EBOOKS = [1, 2, 3, 4]
    EDITIONS = ["10:1", "20:1", "30:1", "40:1", "50:1", "60:1"]

    def snapshot(self):
        db = self.db()
        try:
            books = {b.id: b for b in db.query(book_catalog.Book)}
            for b in books.values():
                db.expunge(b)
            editions = {e.plex_book_key: e.book_id for e in db.query(book_catalog.BookAudioEdition)}
            return books, editions
        finally:
            db.close()

    @staticmethod
    def shape(books, editions):
        by_book = {}
        for key, book_id in editions.items():
            by_book.setdefault(book_id, []).append(key)
        return {i: (b.title, b.author, b.kavita_chapter_id, b.plex_book_key, tuple(sorted(by_book.get(i, []))),
                    b.merged_into, b.work_key, b.ebook_work_key, b.updated_at) for i, b in books.items()}

    @staticmethod
    def resolve(books, book_id):
        for _ in range(60):
            row = books.get(book_id)
            if row is None or row.merged_into is None:
                return row
            book_id = row.merged_into
        raise AssertionError("a chain of ghosts")

    def holder(self, books, editions, item):
        """The id of the live book that holds the item."""
        if item[0] == "k":
            return next((i for i, b in books.items() if b.merged_into is None and b.kavita_chapter_id == item[1]), None)
        owner = editions.get(item[1])
        return owner if owner in books and books[owner].merged_into is None else None

    def check(self, seed, step, present, identities, before, outage, titles):
        books, editions = self.snapshot()
        where = f"seed {seed} step {step}"
        live = {i: b for i, b in books.items() if b.merged_into is None}
        by_book = {}
        for key, book_id in editions.items():
            self.assertIn(book_id, live, f"{where}: an edition is in a book that is not live")
            by_book.setdefault(book_id, []).append(key)
        # Every item is in exactly one live book; no live book is empty or has lost its text.
        for item in present:
            self.assertIsNotNone(self.holder(books, editions, item), f"{where}: {item} is in no book")
        for i, b in live.items():
            self.assertTrue(b.kavita_chapter_id is not None or by_book.get(i), f"{where}: book {i} holds nothing")
            self.assertNotEqual(b.title, "Untitled", where)
            self.assertTrue(b.author, f"{where}: book {i} lost its author")
        self.assertEqual(sorted(c for c in (b.kavita_chapter_id for b in live.values()) if c is not None),
                         sorted(i[1] for i in present if i[0] == "k"), where)
        self.assertEqual(sorted(editions), sorted(i[1] for i in present if i[0] == "p"), where)
        for i, b in books.items():
            if b.merged_into is not None:
                self.assertIn(b.merged_into, live, f"{where}: a ghost points at a book that is not live")
        # An id leads to a book that holds some of what it held when it was last
        # a live book, for as long as any of it is still there. (Where a book
        # was split, which side keeps the id is checked exactly by
        # SplitKeepsIdentity.)
        # A ghost remembers only its primary edition, else its ebook, so that is
        # all that is asked of it.
        for i, (items, primary) in list(identities.items()):
            here = [x for x in (items if i in live else {primary}) if x in present]
            if not here:
                del identities[i]
                continue
            row = self.resolve(books, i)
            self.assertIsNotNone(row, f"{where}: id {i} is gone though {here} is still there")
            held = {x for x in present if self.holder(books, editions, x) == row.id}
            self.assertTrue(held & set(here), f"{where}: id {i} opens another work")
        for i, b in live.items():
            items = frozenset(([("k", b.kavita_chapter_id)] if b.kavita_chapter_id is not None else [])
                              + [("p", k) for k, owner in editions.items() if owner == i])
            identities[i] = (items, ("p", b.plex_book_key) if b.plex_book_key else ("k", b.kavita_chapter_id))
        # What a failed source holds does not move.
        for item, book_id in before.items():
            if item in outage and item in present:
                self.assertEqual(self.holder(books, editions, item), book_id, f"{where}: {item} moved in an outage")
        # A second rebuild with nothing changed changes nothing.
        first = self.shape(books, editions)
        self.rebuild()
        books2, editions2 = self.snapshot()
        self.assertEqual(self.shape(books2, editions2), first, f"{where}: a repeated rebuild changed the catalog")

    def dump(self):
        books, editions = self.snapshot()
        return {i: (b.title, b.kavita_chapter_id, b.plex_book_key, sorted(k for k, v in editions.items() if v == i),
                    b.merged_into) for i, b in sorted(books.items())}

    def test_random_histories(self):
        import random
        for seed in range(30):
            with self.subTest(seed=seed):
                self.run_history(random.Random(seed), seed)

    def run_history(self, rnd, seed):
        db = self.db()
        try:
            for model in (book_catalog.Book, book_catalog.BookAudioEdition, book_catalog.BookPairOverride,
                          book_catalog.BookCatalogMeta):
                db.query(model).delete()
            db.commit()
        finally:
            db.close()
        titles_e, titles_a = {}, {}
        identities, before, history = {}, {}, []
        self.sources.kavita_down = self.sources.plex_down = False
        for step in range(22):
            self.sources.kavita_down = rnd.random() < 0.25
            self.sources.plex_down = rnd.random() < 0.25
            for _ in range(rnd.randint(1, 3)):
                op = rnd.choice(["ebook", "edition", "retag", "pair", "apart", "unoverride"])
                if op == "ebook" and not self.sources.kavita_down:
                    c = rnd.choice(self.EBOOKS)
                    if c in titles_e:
                        del titles_e[c]
                    else:
                        titles_e[c] = rnd.choice(self.TITLES)
                elif op == "edition" and not self.sources.plex_down:
                    k = rnd.choice(self.EDITIONS)
                    if k in titles_a:
                        del titles_a[k]
                    else:
                        titles_a[k] = rnd.choice(self.TITLES)
                elif op == "retag":
                    if rnd.random() < 0.5 and titles_e and not self.sources.kavita_down:
                        titles_e[rnd.choice(sorted(titles_e))] = rnd.choice(self.TITLES)
                    elif titles_a and not self.sources.plex_down:
                        titles_a[rnd.choice(sorted(titles_a))] = rnd.choice(self.TITLES)
                elif op in ("pair", "apart"):
                    c, k = rnd.choice(self.EBOOKS), rnd.choice(self.EDITIONS)
                    self.override(c, k, op)
                    history.append(f"override {op} {c} {k}")
                else:
                    d = self.db()
                    try:
                        rows = d.query(book_catalog.BookPairOverride).all()
                        if rows:
                            o = rnd.choice(rows)
                            book_catalog.remove_override(d, o.kavita_chapter_id, o.plex_book_key)
                    finally:
                        d.close()
            self.sources.ebooks = [ebook(c, t, self.AUTHORS[t]) for c, t in sorted(titles_e.items())]
            self.sources.audiobooks = [audiobook(k, t, self.AUTHORS[t], narrator=f"N{k}",
                                                 added_at=1_600_000_000 + 1000 * int(k[:2]))
                                       for k, t in sorted(titles_a.items())]
            outage = set()
            if self.sources.kavita_down:
                outage |= {("k", c) for c in titles_e}
            if self.sources.plex_down:
                outage |= {("p", k) for k in titles_a}
            present = {("k", c) for c in titles_e} | {("p", k) for k in titles_a}
            self.rebuild()
            history.append((step, sorted(titles_e.items()), sorted(titles_a.items()),
                            "kavita down" if self.sources.kavita_down else "", "plex down" if self.sources.plex_down else "",
                            self.dump()))
            try:
                self.check(seed, step, present, identities, before, outage,
                       {**{('k', c): t for c, t in titles_e.items()}, **{('p', k): t for k, t in titles_a.items()}})
            except AssertionError as exc:
                raise AssertionError(f"{exc}\n" + "\n".join(map(str, history[-8:]))) from None
            books, editions = self.snapshot()
            before = {item: self.holder(books, editions, item) for item in present}


class PairingTitle(unittest.TestCase):
    CASES = [
        # (Kavita title, Kavita series, the title the work key is made from)
        ("Harry Potter 02 - Harry Potter and the Chamber of Secrets", "Harry Potter",
         "Harry Potter and the Chamber of Secrets"),
        ("A Storm of Swords: A Song of Ice and Fire", "A Song of Ice and Fire", "A Storm of Swords"),
        ("Quicksilver (The Fae & Alchemy Series Book 1)", "Fae & Alchemy", "Quicksilver"),
        ("The Gate (Dungeon Crawler Carl #4)", "Dungeon Crawler Carl", "The Gate"),
        ("Dungeon Crawler Carl Book 2: Carl's Doomsday Scenario", "Dungeon Crawler Carl", "Carl's Doomsday Scenario"),
        ("Harry Potter and the Sorcerer's Stone", "Harry Potter", "Harry Potter and the Sorcerer's Stone"),
        ("Catch-22", "", "Catch-22"),
        ("Harry Potter 3", "Harry Potter", "Harry Potter 3"),       # nothing would be left
    ]

    @unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
    def test_the_series_comes_off_the_title_before_the_key_is_made(self):
        for title, series, want in self.CASES:
            with self.subTest(title=title):
                self.assertEqual(book_catalog._pairing_title(title, series), want)

    @unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
    def test_kavita_titles_with_the_series_in_them_pair_with_the_audiobooks(self):
        martin = "George R.R. Martin"
        sources = FakeSources()
        sources.ebooks = [
            ebook(1, "Harry Potter 02 - Harry Potter and the Chamber of Secrets", "J. K. Rowling",
                  series="Harry Potter", series_number=2),
            ebook(2, "A Storm of Swords: A Song of Ice and Fire", martin, series="A Song of Ice and Fire",
                  series_number=3),
        ]
        items = [book_catalog._ebook_item(e) for e in sources.ebooks]
        self.assertEqual(items[0].key, plex_player.work_key("J.K. Rowling", "Harry Potter and the Chamber of Secrets"))
        self.assertEqual(items[1].key, plex_player.work_key(martin, "A Storm of Swords"))
        self.assertEqual(book_catalog._ebook_item(ebook(3, "Catch-22", "Joseph Heller")).fields["title"], "Catch-22")


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

    def add_series(self, series_id, name, folder, books):
        """books: [(chapter id, volume number, writers)] as numbered volumes."""
        self.series.append({"id": series_id, "name": name, "libraryId": 1, "folderPath": folder})
        self.detail[series_id] = {"volumes": [
            {"id": 1000 + cid, "name": f"{name} {number}", "minNumber": number, "chapters": [{"id": cid}]}
            for cid, number, _ in books]}
        for cid, number, writers in books:
            self.chapters[cid] = {"id": cid, "titleName": f"{name} {number}", "createdUtc": "2026-01-01T00:00:00",
                                  "summary": "", "writers": [{"name": w} for w in writers]}

    def authors(self, writers, folder="/ebooks/Somewhere"):
        self.add_series(80, "Standalone", folder, [(801, 1, writers)])
        return self.read()[801]["author"]

    def test_a_last_first_author_that_kavita_split_is_put_back_together(self):
        self.assertEqual(self.authors(["King", "Stephen"]), "Stephen King")
        self.assertEqual(self.authors(["Maas", "Sarah J."]), "Sarah J. Maas")

    def test_two_people_are_never_glued_together(self):
        self.assertEqual(self.authors(["Neil Gaiman", "Terry Pratchett"]), "Neil Gaiman")      # co-authors
        self.assertEqual(self.authors(["Homer", "Emily Wilson"]), "Homer")                      # writer and translator
        self.assertEqual(self.authors(["J. K. Rowling", "Jim Dale"]), "J. K. Rowling")
        self.assertEqual(self.authors(["Ann Author", "Bo", "Cy Dee"]), "Ann Author")

    def test_the_authors_folder_settles_what_the_names_cannot(self):
        # A given name of two plain words looks like a second person, until the folder is named for the joined name.
        self.assertEqual(self.authors(["Maas", "Sarah Jane"], "/ebooks/Sarah Jane Maas"), "Sarah Jane Maas")
        self.assertEqual(self.authors(["Maas", "Sarah Jane"], "/ebooks/Misc"), "Maas")
        # Two single words are a split name, unless the folder is named for one of them: then they are two people.
        self.assertEqual(self.authors(["Plato", "Aristotle"], "/ebooks/Misc"), "Aristotle Plato")
        self.assertEqual(self.authors(["Plato", "Aristotle"], "/ebooks/Plato"), "Plato")
        self.assertEqual(self.authors(["Homer", "Emily Wilson"], "/ebooks/Homer"), "Homer")

    def test_a_book_with_no_writer_takes_the_author_its_series_agrees_on(self):
        self.add_series(70, "Saga", "/ebooks/Saga", [(701, 1, ["Ann Author"]), (702, 2, []), (703, 3, ["ann author"])])
        books = self.read()
        self.assertEqual(books[702]["author"], "Ann Author")

    def test_a_book_in_a_series_whose_authors_disagree_stays_without_one(self):
        self.add_series(71, "Mixed", "/ebooks/Mixed", [(711, 1, ["Ann Author"]), (712, 2, []), (713, 3, ["Bo Co"])])
        self.assertEqual(self.read()[712]["author"], "")

    def test_a_book_with_no_writer_takes_the_author_of_the_other_books_in_its_folder(self):
        # Kavita holds a standalone book as a series of its own: its neighbours are in the author's folder.
        self.add_series(72, "Odd Standalone Title", "/ebooks/J.K. Rowling", [(721, 1, ["authors_sort"])])
        self.add_series(73, "Harry Potter", "/ebooks/J.K. Rowling", [(731, 1, ["J. K. Rowling"]), (732, 2, ["J. K. Rowling"])])
        self.series_writers[72] = ["authors_sort"]
        self.assertEqual(self.read()[721]["author"], "J. K. Rowling")

    def test_a_folder_that_holds_two_authors_gives_no_author(self):
        self.add_series(74, "Alone", "/ebooks", [(741, 1, [])])
        self.add_series(75, "Other One", "/ebooks", [(751, 1, ["Ann Author"])])
        self.add_series(76, "Other Two", "/ebooks", [(761, 1, ["Bo Co"])])
        self.assertEqual(self.read()[741]["author"], "")

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
