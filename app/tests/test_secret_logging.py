"""
A failed write never puts the value being written into the log.

With two uvicorn workers on one SQLite file, a settings save or the setup
wizard can lose the write lock ("database is locked"). The failure is logged
with its traceback, and SQLAlchemy's error text used to end with the bound
parameters: the Plex token, API key or client secret being saved. The engine
hides them (hide_parameters), so the traceback keeps the SQL and the error
but never the values.

Each test holds the write lock from a second connection on a temporary
database file, the way the other worker would, and reads the log output.
"""
import logging
import os
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from unittest import mock

try:
    from sqlalchemy.orm import sessionmaker

    from app import models  # noqa: F401 - registers the tables on Base
    from app import database
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False

SYNTH = "SYNTH-TOKEN-5e1f"
SYNTH_SECRET_KEY = "SYNTH-SECRET-KEY-9a0c"
SETUP_TOKEN = "first-run-token-log-3b"


def rendered(records) -> str:
    """The records as the container log prints them, tracebacks included."""
    fmt = logging.Formatter("%(levelname)s %(name)s %(message)s")
    return "\n".join(fmt.format(r) for r in records)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class LostWriteLock(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "race.db")
        # The app's own engine options; a short busy timeout so the lost race
        # fails in a tenth of a second rather than five.
        self.engine = database.make_engine("sqlite:///" + self.path,
                                           connect_args={"check_same_thread": False, "timeout": 0.1})
        database.Base.metadata.create_all(bind=self.engine)
        self.Session = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)

    def tearDown(self):
        self.engine.dispose()
        self.dir.cleanup()

    @contextmanager
    def write_lock(self):
        """Hold SQLite's write lock from another connection, as the other worker would."""
        con = sqlite3.connect(self.path, isolation_level=None)
        con.execute("BEGIN IMMEDIATE")
        try:
            yield
        finally:
            con.execute("ROLLBACK")
            con.close()

    def test_the_app_engine_hides_parameters(self):
        self.assertTrue(database.engine.hide_parameters)

    def test_a_settings_save_that_loses_the_lock_logs_no_value(self):
        from app.routers.admin_settings import SAVE_FAILED_MESSAGE
        setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        setup_patch.start()
        self.addCleanup(setup_patch.stop)
        client = helpers.api_client(self.Session)
        self.addCleanup(helpers.reset_overrides)
        with self.write_lock(), self.assertLogs("app.routers.admin_settings", level="WARNING") as logs:
            r = client.put("/api/admin/settings/bulk",
                           json={"settings": [{"key": "integration.plex.token", "value": SYNTH}]})
        self.assertEqual(r.status_code, 503, r.text)
        self.assertEqual(r.json()["detail"], SAVE_FAILED_MESSAGE)
        out = rendered(logs.records)
        self.assertNotIn(SYNTH, out)
        self.assertNotIn(SYNTH, r.text)
        # The diagnostics stay: the traceback, the error and the statement.
        self.assertIn("Traceback", out)
        self.assertIn("database is locked", out)
        self.assertIn("INSERT INTO settings", out)
        self.assertIn("parameters hidden", out)
        with self.Session() as db:
            self.assertIsNone(helpers.get(db, "integration.plex.token"))

    def test_setup_that_loses_the_lock_logs_no_value(self):
        from app.config import settings as app_settings
        from app.routers import setup
        saved = (setup._setup_done, setup._setup_token, app_settings.app_secret_key)
        self.addCleanup(lambda: setattr(setup, "_setup_done", saved[0]))
        self.addCleanup(lambda: setattr(setup, "_setup_token", saved[1]))
        self.addCleanup(lambda: setattr(app_settings, "app_secret_key", saved[2]))
        for p in (mock.patch("app.routers.setup.is_setup_completed", return_value=False),
                  mock.patch("app.routers.setup.get_or_create_setup_token", return_value=SETUP_TOKEN),
                  mock.patch("app.routers.setup.SessionLocal", self.Session)):
            p.start()
            self.addCleanup(p.stop)
        client = helpers.api_client(self.Session)
        self.addCleanup(helpers.reset_overrides)
        with self.write_lock(), self.assertLogs("app.routers.setup", level="ERROR") as logs:
            r = client.post("/api/setup/complete", json={
                "username": "owner", "password": "long-enough-pw", "password_confirm": "long-enough-pw",
                "setup_token": SETUP_TOKEN, "secret_key": SYNTH_SECRET_KEY,
                "plex_url": "http://192.168.1.9:32400", "plex_token": SYNTH})
        self.assertEqual(r.status_code, 500, r.text)
        out = rendered(logs.records)
        self.assertNotIn(SYNTH, out)
        self.assertNotIn(SYNTH_SECRET_KEY, out)
        self.assertNotIn(SYNTH, r.text)
        self.assertIn("database is locked", out)
        self.assertIn("parameters hidden", out)


if __name__ == "__main__":
    unittest.main()
