"""
The audiobook player's store (app/services/listening.py): listening positions,
the check-in log, player preferences, log pruning, and the audiobook library
setting that turns the player on.

Everything is keyed by account identity ("plex:<id>"), never username. A
page session (psid) numbers its check-ins (seq): an older seq from the same
psid never overwrites the stored position, and across page sessions or
devices the most recently received check-in wins.
"""
import unittest
from datetime import datetime, timedelta
from unittest import mock

try:
    from app.tests import helpers
    from app import settings_registry as reg
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False
if HAVE_APP:
    from app.services import listening

ME = "plex:1001"
THEM = "plex:2002"
BOOK = "5001"
LIB_KEY = "integration.plex.audiobook_library"


def checkin(db, identity=ME, book=BOOK, track="6001", offset_ms=1000, duration_ms=60000,
            event="checkin", device="Chrome on Android", psid="p-one", seq=1, **kw):
    return listening.save_checkin(db, identity, book, track, offset_ms, duration_ms,
                                  event, device, psid, seq, **kw)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class StoreBase(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()

    def tearDown(self):
        self.db.close()

    def log_count(self, identity=ME, book=BOOK):
        return len(listening.get_history(self.db, identity, book))


class Tables(StoreBase):
    def test_tables_keys_and_index(self):
        from sqlalchemy import inspect
        insp = inspect(self.Session.kw["bind"])
        cols = {c["name"] for c in insp.get_columns("listening_positions")}
        self.assertEqual(cols, {"identity", "book_key", "track_key", "offset_ms", "duration_ms", "updated_at",
                                "device", "device_id", "source", "psid", "seq"})
        pk = insp.get_pk_constraint("listening_positions")["constrained_columns"]
        uniques = [u["column_names"] for u in insp.get_unique_constraints("listening_positions")]
        self.assertTrue(sorted(pk) == ["book_key", "identity"] or ["identity", "book_key"] in uniques,
                        "one row per identity and book")
        cols = {c["name"] for c in insp.get_columns("listening_log")}
        self.assertEqual(cols, {"id", "identity", "book_key", "track_key", "offset_ms", "device", "device_id",
                                "event", "at"})
        self.assertIn(["identity", "book_key", "at"],
                      [i["column_names"] for i in insp.get_indexes("listening_log")])
        cols = {c["name"] for c in insp.get_columns("player_prefs")}
        self.assertEqual(cols, {"identity", "skip_s", "speed", "smart_rewind"})
        self.assertEqual(insp.get_pk_constraint("player_prefs")["constrained_columns"], ["identity"])


class Positions(StoreBase):
    def test_save_then_get(self):
        out = checkin(self.db, track="6002", offset_ms=123456, duration_ms=3600000, device="Safari on iPhone")
        self.assertTrue(out["stored"])
        self.assertRegex(out["updated_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
        pos = listening.get_position(self.db, ME, BOOK)
        self.assertEqual(pos, {"track": "6002", "offset_ms": 123456, "duration_ms": 3600000,
                               "updated_at": out["updated_at"], "device": "Safari on iPhone", "device_id": None,
                               "source": "web"})
        hist = listening.get_history(self.db, ME, BOOK)
        self.assertEqual(len(hist), 1)
        self.assertEqual(hist[0]["event"], "checkin")
        self.assertEqual(hist[0]["offset_ms"], 123456)
        self.assertEqual(hist[0]["track"], "6002")

    def test_no_position_is_none(self):
        self.assertIsNone(listening.get_position(self.db, ME, BOOK))
        self.assertEqual(listening.get_history(self.db, ME, BOOK), [])

    def test_a_newer_seq_from_the_same_psid_overwrites(self):
        checkin(self.db, offset_ms=1000, seq=1)
        self.assertTrue(checkin(self.db, offset_ms=2000, seq=2)["stored"])
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["offset_ms"], 2000)
        self.assertEqual(self.log_count(), 2)

    def test_an_older_seq_from_the_same_psid_is_not_stored_or_logged(self):
        first = checkin(self.db, offset_ms=5000, seq=7)
        late = checkin(self.db, offset_ms=1000, seq=6)
        self.assertFalse(late["stored"])
        self.assertEqual(late["updated_at"], first["updated_at"], "the stored row's timestamp")
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["offset_ms"], 5000)
        self.assertEqual(self.log_count(), 1, "a refused check-in is not logged")

    def test_a_different_psid_always_stores(self):
        checkin(self.db, offset_ms=900000, psid="phone", seq=40, device="Chrome on Android")
        # Another tab or device, even with a lower seq and an earlier offset:
        # the most recently received check-in wins.
        out = checkin(self.db, offset_ms=10000, psid="laptop", seq=1, device="Firefox on Linux")
        self.assertTrue(out["stored"])
        pos = listening.get_position(self.db, ME, BOOK)
        self.assertEqual((pos["offset_ms"], pos["device"]), (10000, "Firefox on Linux"))
        # The stored row now belongs to "laptop": its own older seq is refused...
        self.assertFalse(checkin(self.db, offset_ms=5, psid="laptop", seq=0)["stored"])
        # ...and "phone" coming back stores again.
        self.assertTrue(checkin(self.db, offset_ms=950000, psid="phone", seq=41)["stored"])
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["offset_ms"], 950000)
        self.assertEqual(self.log_count(), 3)

    def test_identities_are_isolated(self):
        checkin(self.db, identity=ME, offset_ms=1111, psid="same", seq=5)
        # Same book, same psid and a lower seq: a different identity is its own row.
        self.assertTrue(checkin(self.db, identity=THEM, offset_ms=2222, psid="same", seq=1)["stored"])
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["offset_ms"], 1111)
        self.assertEqual(listening.get_position(self.db, THEM, BOOK)["offset_ms"], 2222)
        self.assertEqual([h["offset_ms"] for h in listening.get_history(self.db, ME, BOOK)], [1111])
        self.assertEqual([h["offset_ms"] for h in listening.get_history(self.db, THEM, BOOK)], [2222])
        listening.put_prefs(self.db, THEM, skip_s=30)
        self.assertEqual(listening.get_prefs(self.db, ME)["skip_s"], 10)
        self.assertEqual(listening.get_prefs(self.db, THEM)["skip_s"], 30)

    def test_books_are_separate_rows(self):
        checkin(self.db, book="5001", offset_ms=1)
        checkin(self.db, book="5002", offset_ms=2, psid="p-one", seq=0)
        self.assertEqual(listening.get_position(self.db, ME, "5001")["offset_ms"], 1)
        self.assertEqual(listening.get_position(self.db, ME, "5002")["offset_ms"], 2)

    def test_history_is_newest_first_and_limited(self):
        for i in range(5):
            checkin(self.db, offset_ms=i * 1000, seq=i, event="play" if i == 0 else "checkin")
        hist = listening.get_history(self.db, ME, BOOK)
        self.assertEqual([h["offset_ms"] for h in hist], [4000, 3000, 2000, 1000, 0])
        self.assertEqual(set(hist[0]), {"track", "offset_ms", "device", "device_id", "event", "at"})
        self.assertEqual([h["offset_ms"] for h in listening.get_history(self.db, ME, BOOK, limit=2)], [4000, 3000])

    def test_source_is_recorded(self):
        checkin(self.db, source="local")
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["source"], "local")

    def test_bad_input_is_refused(self):
        bad = [
            dict(identity=""), dict(event="rewind"), dict(offset_ms=-1), dict(duration_ms=-5),
            dict(offset_ms=1.5), dict(offset_ms=True), dict(seq=-1), dict(book=""), dict(track=""),
            dict(psid=""), dict(source="kindle"),
        ]
        for kw in bad:
            with self.subTest(kw):
                with self.assertRaises(ValueError):
                    checkin(self.db, **kw)
        self.assertIsNone(listening.get_position(self.db, ME, BOOK))

    def test_every_spec_event_is_accepted(self):
        for i, ev in enumerate(("play", "pause", "checkin", "seek", "jump", "leave", "end")):
            self.assertTrue(checkin(self.db, event=ev, seq=i)["stored"], ev)

    def test_a_long_device_label_is_cut_not_refused(self):
        checkin(self.db, device="x" * 500)
        self.assertLessEqual(len(listening.get_position(self.db, ME, BOOK)["device"]), 80)


class DeviceIds(StoreBase):
    """Each browser's own random id rides on its check-ins, so the handoff
    prompt can tell two devices with one label apart."""

    ID_A = "k3v9x0q2m7w1p4z8r6t5y2u0"
    ID_B = "b" * 40

    def test_the_position_and_the_log_carry_the_id(self):
        checkin(self.db, device_id=self.ID_A)
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["device_id"], self.ID_A)
        self.assertEqual(listening.get_history(self.db, ME, BOOK)[0]["device_id"], self.ID_A)
        page = listening.get_history_page(self.db, ME, BOOK)
        self.assertEqual(page["entries"][0]["device_id"], self.ID_A)

    def test_the_newest_checkin_sets_it_and_none_clears_it(self):
        checkin(self.db, device_id=self.ID_A, psid="p-a", seq=1)
        checkin(self.db, device_id=self.ID_B, psid="p-b", seq=1)
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["device_id"], self.ID_B)
        checkin(self.db, psid="p-c", seq=1)      # an older player that sends none
        self.assertIsNone(listening.get_position(self.db, ME, BOOK)["device_id"])
        self.assertEqual([e["device_id"] for e in listening.get_history(self.db, ME, BOOK)],
                         [None, self.ID_B, self.ID_A])

    def test_a_refused_older_seq_keeps_the_stored_id(self):
        checkin(self.db, device_id=self.ID_A, seq=5)
        self.assertFalse(checkin(self.db, device_id=self.ID_B, seq=4)["stored"])
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["device_id"], self.ID_A)

    def test_a_malformed_id_is_refused(self):
        for bad in ("", "short", "A" * 20, "a" * 41, "abc-def-ghi-jkl-mno", "a" * 15, 12345678901234567, " " + "a" * 20):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    checkin(self.db, device_id=bad)
        self.assertIsNone(listening.get_position(self.db, ME, BOOK))
        self.assertEqual(self.log_count(), 0)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class DeviceIdMigration(unittest.TestCase):
    """An install from before device ids gets the columns added, once, with
    its rows kept (and a null id)."""

    def old_schema(self):
        from sqlalchemy import create_engine, text
        from sqlalchemy.orm import sessionmaker
        from sqlalchemy.pool import StaticPool
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        with engine.begin() as conn:
            conn.execute(text(
                "CREATE TABLE listening_positions (identity VARCHAR(255) NOT NULL, book_key VARCHAR(64) NOT NULL, "
                "track_key VARCHAR(64) NOT NULL, offset_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL, "
                "updated_at DATETIME NOT NULL, device VARCHAR(80) NOT NULL, source VARCHAR(10) NOT NULL, "
                "psid VARCHAR(64), seq INTEGER, PRIMARY KEY (identity, book_key))"))
            conn.execute(text(
                "CREATE TABLE listening_log (id INTEGER PRIMARY KEY, identity VARCHAR(255) NOT NULL, "
                "book_key VARCHAR(64) NOT NULL, track_key VARCHAR(64) NOT NULL, offset_ms INTEGER NOT NULL, "
                "device VARCHAR(80) NOT NULL, event VARCHAR(16) NOT NULL, at DATETIME NOT NULL)"))
            conn.execute(text(
                "INSERT INTO listening_positions VALUES ('plex:1', '5:1', '6', 10, 20, '2026-09-01 00:00:00', "
                "'Chrome on Linux', 'web', 'p', 1)"))
            conn.execute(text(
                "INSERT INTO listening_log (identity, book_key, track_key, offset_ms, device, event, at) "
                "VALUES ('plex:1', '5:1', '6', 10, 'Chrome on Linux', 'pause', '2026-09-01 00:00:00')"))
        return sessionmaker(bind=engine)()

    @staticmethod
    def columns(db, table):
        from sqlalchemy import text
        return {row[1] for row in db.execute(text(f"PRAGMA table_info({table})"))}

    def test_adds_the_columns_once_and_keeps_the_rows(self):
        import logging
        from sqlalchemy import text
        from app.seed import migrate_listening_device_id
        db = self.old_schema()
        try:
            with self.assertLogs("app.seed", level=logging.INFO):
                migrate_listening_device_id(db)
            with self.assertNoLogs("app.seed", level=logging.INFO):
                migrate_listening_device_id(db)   # idempotent: nothing left to do
            self.assertIn("device_id", self.columns(db, "listening_positions"))
            self.assertIn("device_id", self.columns(db, "listening_log"))
            self.assertEqual(tuple(db.execute(text("SELECT offset_ms, device_id FROM listening_positions")).one()),
                             (10, None))
            self.assertEqual(tuple(db.execute(text("SELECT event, device_id FROM listening_log")).one()),
                             ("pause", None))
            # The store works on the upgraded tables.
            self.assertEqual(listening.get_position(db, "plex:1", "5:1")["device_id"], None)
        finally:
            db.close()

    def test_no_op_on_a_fresh_schema_and_before_the_tables_exist(self):
        import logging
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from app.seed import migrate_listening_device_id
        db = helpers.make_sessionmaker()()
        try:
            with self.assertNoLogs("app.seed", level=logging.INFO):
                migrate_listening_device_id(db)
            self.assertIn("device_id", self.columns(db, "listening_log"))
        finally:
            db.close()
        empty = sessionmaker(bind=create_engine("sqlite://"))()
        try:
            migrate_listening_device_id(empty)     # no tables yet: create_all makes them
            self.assertEqual(self.columns(empty, "listening_log"), set())
        finally:
            empty.close()

    def test_init_db_runs_it(self):
        import inspect as pyinspect
        from app import database
        self.assertIn("migrate_listening_device_id(db)", pyinspect.getsource(database.init_db))


class Prefs(StoreBase):
    def test_defaults(self):
        self.assertEqual(listening.get_prefs(self.db, ME), {"skip_s": 10, "speed": 1.0, "smart_rewind": True})

    def test_put_merges_and_returns(self):
        out = listening.put_prefs(self.db, ME, speed=1.25)
        self.assertEqual(out, {"skip_s": 10, "speed": 1.25, "smart_rewind": True})
        out = listening.put_prefs(self.db, ME, skip_s=30, smart_rewind=False)
        self.assertEqual(out, {"skip_s": 30, "speed": 1.25, "smart_rewind": False})
        self.assertEqual(listening.get_prefs(self.db, ME), out)

    def test_bounds(self):
        for v in (5, 60):
            self.assertEqual(listening.put_prefs(self.db, ME, skip_s=v)["skip_s"], v)
        for v in (0.75, 1.05, 1.5, 2.0):
            self.assertEqual(listening.put_prefs(self.db, ME, speed=v)["speed"], v)

    def test_validation(self):
        bad = [dict(skip_s=4), dict(skip_s=61), dict(skip_s=10.5), dict(skip_s=True), dict(skip_s="10"),
               dict(speed=2.05), dict(speed=0.7), dict(speed=1.03), dict(speed="1.0"), dict(speed=float("nan")),
               dict(smart_rewind="yes"), dict(volume=3),
               # Too big for float arithmetic: a ValueError, never an OverflowError.
               dict(speed=1e308), dict(speed=-1e308), dict(speed=10 ** 400), dict(speed=-(10 ** 400)),
               dict(speed=float("inf")), dict(speed=float("-inf")), dict(skip_s=10 ** 400)]
        for kw in bad:
            with self.subTest(kw):
                with self.assertRaises(ValueError):
                    listening.put_prefs(self.db, ME, **kw)
        self.assertEqual(listening.get_prefs(self.db, ME), {"skip_s": 10, "speed": 1.0, "smart_rewind": True})


class Pruning(StoreBase):
    NOW = datetime(2026, 9, 28, 12, 0, 0)

    def add_log(self, days_ago):
        from app.models import ListeningLog
        self.db.add(ListeningLog(identity=ME, book_key=BOOK, track_key="6001", offset_ms=days_ago,
                                 device="d", event="checkin", at=self.NOW - timedelta(days=days_ago)))
        self.db.commit()

    def test_prune_removes_181_day_rows_and_keeps_179(self):
        self.add_log(181)
        self.add_log(179)
        self.add_log(1)
        self.assertEqual(listening.prune_log(self.db, now=self.NOW), 1)
        self.assertEqual(sorted(h["offset_ms"] for h in listening.get_history(self.db, ME, BOOK)), [1, 179])

    def test_prune_leaves_positions_alone(self):
        checkin(self.db)
        listening.prune_log(self.db, now=datetime.utcnow() + timedelta(days=400))
        self.assertIsNotNone(listening.get_position(self.db, ME, BOOK))

    def test_prune_if_due_runs_at_most_once_a_day(self):
        self.add_log(181)
        self.assertEqual(listening.prune_if_due(self.db, now=self.NOW), 1)
        self.assertIsNotNone(helpers.get(self.db, listening.PRUNED_AT_KEY), "a timestamp row, not a module cache")
        self.add_log(200)
        self.assertIsNone(listening.prune_if_due(self.db, now=self.NOW + timedelta(hours=23)))
        self.assertEqual(self.log_count(), 1)
        self.assertEqual(listening.prune_if_due(self.db, now=self.NOW + timedelta(hours=25)), 1)

    def test_a_bad_marker_does_not_stop_pruning(self):
        helpers.put(self.db, listening.PRUNED_AT_KEY, "not a time")
        self.add_log(181)
        self.assertEqual(listening.prune_if_due(self.db, now=self.NOW), 1)

    def test_the_marker_is_not_an_operator_setting(self):
        self.assertIsNone(reg.get_def(listening.PRUNED_AT_KEY))
        self.assertNotIn(listening.PRUNED_AT_KEY, reg.seed_defaults())

    def test_startup_prunes(self):
        from app import database
        self.add_log(181)
        with mock.patch.object(database, "engine", self.Session.kw["bind"]), \
                mock.patch.object(database, "SessionLocal", self.Session):
            database.init_db()
        self.assertEqual(self.log_count(), 0)
        self.assertIsNotNone(helpers.get(self.db, listening.PRUNED_AT_KEY))

    def test_a_checkin_prunes_when_due(self):
        from app.models import ListeningLog
        self.db.add(ListeningLog(identity=THEM, book_key=BOOK, track_key="6001", offset_ms=0, device="d",
                                 event="checkin", at=datetime.utcnow() - timedelta(days=200)))
        self.db.commit()
        checkin(self.db)
        self.assertEqual(self.log_count(THEM), 0)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class LibrarySetting(unittest.TestCase):
    def test_definition(self):
        d = reg.get_def(LIB_KEY)
        self.assertIsNotNone(d)
        self.assertEqual((d.type, d.default), ("text", ""))
        self.assertFalse(d.public, "admin-only: never in the public branding payload")
        self.assertFalse(d.secret)
        self.assertEqual(reg.seed_defaults()[LIB_KEY][0], "")
        from app.routers import branding
        self.assertNotIn(LIB_KEY, branding.DEFAULTS)

    def test_validation(self):
        for ok in ("", "1", "5", "123456"):
            self.assertIsNone(reg.validate_value(LIB_KEY, ok), ok)
        for bad in ("abc", "5a", " 5", "5 ", "-1", "1.5", " ", "٥", "1234567890123"):
            self.assertIsNotNone(reg.validate_value(LIB_KEY, bad), bad)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class LibrarySettingApi(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()
        self.db.close()

    def save(self, client, value):
        return client.put("/api/admin/settings/bulk", json={"settings": [{"key": LIB_KEY, "value": value}]})

    def test_admin_saves_and_reads_it(self):
        client = helpers.api_client(self.Session, helpers.ADMIN)
        self.assertEqual(self.save(client, "7").status_code, 200)
        self.assertEqual(helpers.get(self.db, LIB_KEY), "7")
        body = client.get("/api/admin/settings?view=registry").json()
        self.assertEqual(body["values"][LIB_KEY], "7")
        self.assertIn(LIB_KEY, body["meta"])
        r = self.save(client, "books")
        self.assertEqual(r.status_code, 422)
        self.assertIn(LIB_KEY, r.json()["errors"])
        self.assertEqual(self.save(client, "").status_code, 200)
        self.assertEqual(helpers.get(self.db, LIB_KEY), "")

    def test_members_cannot_read_or_write_it(self):
        helpers.put(self.db, LIB_KEY, "7")
        client = helpers.api_client(self.Session, helpers.MEMBER)
        self.assertEqual(self.save(client, "9").status_code, 403)
        self.assertEqual(client.get("/api/admin/settings?view=registry").status_code, 403)
        self.assertEqual(helpers.get(self.db, LIB_KEY), "7")
        r = client.get("/api/branding")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(LIB_KEY, r.text)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SettingsField(unittest.TestCase):
    def test_the_integrations_tab_shows_it_on_the_plex_card(self):
        from pathlib import Path
        import app
        src = (Path(app.__file__).parent / "static" / "js" / "settings" / "integrations.js").read_text(
            encoding="utf-8")
        plex = src[src.index("plex: {"):src.index("seerr: {")]
        self.assertIn("'integration.plex.audiobook_library'", plex)


if __name__ == "__main__":
    unittest.main()
