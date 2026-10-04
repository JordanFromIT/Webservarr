"""
The Books catalog (sub-project 3a, task 1): the combined ebook and audiobook
store, its rebuild, its pairing overrides, the Chaptarr import webhook and the
server-side Kavita read.

Kavita and Plex are faked at the integration boundary (kavita.list_series and
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


def ebook(series_id, title, author="Frank Herbert", **kw):
    return {"id": series_id, "library_id": 1, "title": title, "sort_title": title, "author": author,
            "description": "", "added_at": datetime(2026, 8, 1), **kw}


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

    async def list_series(self):
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
            mock.patch.object(kavita, "list_series", self.sources.list_series),
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
        """{(kavita id, plex key): book id} for the live books."""
        db = self.db()
        try:
            return {(b.kavita_series_id, b.plex_book_key): b.id
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
            rows = [(o.kavita_series_id, o.plex_book_key, o.action)
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
                book_catalog.BookPairOverride(kavita_series_id=1, plex_book_key="10:1", action="pair",
                                              created_by="a", created_at=datetime(2026, 1, 1)),
                book_catalog.BookPairOverride(kavita_series_id=1, plex_book_key="20:1", action="pair",
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
        self.assertIsNone(self.book(self.a_id).kavita_series_id)

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

kavita.list_series = slow_kavita
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


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class KavitaRead(unittest.TestCase):
    """kavita.list_series against a fake Kavita."""
    KEY = "kavita-key-for-the-test"

    def setUp(self):
        self.requests = []
        self.series = [
            {"id": 7, "name": "Dune", "sortName": "Dune", "libraryId": 1, "created": "2026-08-14T18:52:23.5081475"},
            {"id": 8, "name": "Emma", "sortName": "", "libraryId": 2, "created": "bad"},
        ]
        self.metadata = {7: {"summary": "A <b>desert</b> planet.<br>Spice &amp; sand.",
                             "writers": [{"name": "Frank Herbert"}, {"name": "Someone Else"}]},
                         8: {"summary": None, "writers": []}}
        self.answers = {"authenticate": 200, "series": 200}
        self.real_client = httpx.AsyncClient
        patchers = [
            mock.patch.object(kavita.integration_config, "read", self.read_settings),
            mock.patch.object(kavita.httpx, "AsyncClient", self.client),
        ]
        for p in patchers:
            p.start()
            self.addCleanup(p.stop)
        self.settings = {kavita.URL_KEY: "http://kavita.test:5000/", kavita.API_KEY: self.KEY}

    def read_settings(self, keys):
        return {k: self.settings.get(k) for k in keys}

    def client(self, **kwargs):
        return self.real_client(transport=httpx.MockTransport(self.handle))

    def handle(self, request):
        self.requests.append(request)
        path = request.url.path
        if path == "/api/Plugin/authenticate":
            if self.answers["authenticate"] != 200 or request.url.params.get("apiKey") != self.KEY:
                return httpx.Response(401)
            return httpx.Response(200, json={"token": "jwt"})
        if request.headers.get("authorization") != "Bearer jwt":
            return httpx.Response(401)
        if path == "/api/Series/all-v2":
            if self.answers["series"] != 200:
                return httpx.Response(self.answers["series"])
            return httpx.Response(200, json=self.series,
                                  headers={"Pagination": json.dumps({"currentPage": 1, "totalPages": 1})})
        if path == "/api/Series/metadata":
            return httpx.Response(200, json=self.metadata[int(request.url.params["seriesId"])])
        return httpx.Response(404)

    def read(self):
        return asyncio.run(kavita.list_series())

    def test_it_lists_every_series_with_author_and_plain_summary(self):
        books = self.read()
        self.assertEqual([b["id"] for b in books], [7, 8])
        self.assertEqual(books[0]["author"], "Frank Herbert")
        self.assertEqual(books[0]["description"], "A desert planet.\nSpice & sand.")
        self.assertEqual((books[0]["title"], books[0]["library_id"]), ("Dune", 1))
        self.assertEqual(books[0]["added_at"], datetime(2026, 8, 14, 18, 52, 23, 508147))
        self.assertEqual((books[1]["sort_title"], books[1]["author"], books[1]["added_at"]), ("Emma", "", None))
        self.assertTrue(all(str(r.url).startswith("http://kavita.test:5000/") for r in self.requests))

    def test_it_pages_through_a_long_library(self):
        self.series = [{"id": i, "name": f"B{i}", "libraryId": 1} for i in range(1, 4)]
        self.metadata = {i: {} for i in range(1, 4)}
        pages = {1: self.series[:2], 2: self.series[2:]}
        original = self.handle

        def paged(request):
            if request.url.path == "/api/Series/all-v2":
                page = int(request.url.params["PageNumber"])
                return httpx.Response(200, json=pages[page],
                                      headers={"Pagination": json.dumps({"currentPage": page, "totalPages": 2})})
            return original(request)

        self.handle = paged
        self.assertEqual([b["id"] for b in self.read()], [1, 2, 3])

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
