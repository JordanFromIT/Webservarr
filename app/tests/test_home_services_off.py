"""
Home's Service Health section is off by default (the header's status pill
says whether everything is running): the shipped default, the one-time
migration of the earlier default, and the header gauges that no longer
depend on the section.
"""
import os
import tempfile
import unittest

from app.tests import helpers

try:
    import httpx  # noqa: F401 - only present with the app's dependencies
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import sessionmaker
    from app import seed
    from app.settings_registry import REGISTRY
    from app.tests.test_book_catalog import STARTUP_CHILD, run_together
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

KEY = "home.section_services"
MARKER = "migration.home_services_off_v1"


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Default(unittest.TestCase):
    def test_shipped_off_and_the_rest_on(self):
        self.assertEqual(REGISTRY[KEY].default, "false")
        for sid in ("news", "streams", "releases", "requests"):
            self.assertEqual(REGISTRY[f"home.section_{sid}"].default, "true", sid)

    def test_a_fresh_install_seeds_it_off_and_the_migration_leaves_it(self):
        db = helpers.make_sessionmaker()()
        try:
            seed.seed_default_settings(db)
            self.assertEqual(helpers.get(db, KEY), "false")
            seed.migrate_home_services_off_v1(db)
            self.assertEqual(helpers.get(db, KEY), "false")
            self.assertEqual(helpers.get(db, MARKER), "done")
        finally:
            db.close()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Migration(unittest.TestCase):
    def setUp(self):
        self.db = helpers.make_sessionmaker()()

    def tearDown(self):
        self.db.close()

    def test_the_earlier_default_is_switched_off(self):
        helpers.put(self.db, KEY, "true")
        self.db.commit()
        seed.migrate_home_services_off_v1(self.db)
        self.assertEqual(helpers.get(self.db, KEY), "false")

    def test_a_section_already_off_stays_off_and_others_are_untouched(self):
        helpers.put(self.db, KEY, "false")
        helpers.put(self.db, "home.section_news", "true")
        helpers.put(self.db, "home.section_streams", "false")
        self.db.commit()
        seed.migrate_home_services_off_v1(self.db)
        self.assertEqual(helpers.get(self.db, KEY), "false")
        self.assertEqual(helpers.get(self.db, "home.section_news"), "true")
        self.assertEqual(helpers.get(self.db, "home.section_streams"), "false")

    def test_no_row_writes_none(self):
        seed.migrate_home_services_off_v1(self.db)
        self.assertIsNone(helpers.get(self.db, KEY))
        self.assertEqual(helpers.get(self.db, MARKER), "done")

    def test_runs_once_so_turning_it_back_on_sticks(self):
        helpers.put(self.db, KEY, "true")
        self.db.commit()
        seed.migrate_home_services_off_v1(self.db)
        helpers.put(self.db, KEY, "true")        # the admin turns it back on
        self.db.commit()
        seed.migrate_home_services_off_v1(self.db)
        self.assertEqual(helpers.get(self.db, KEY), "true")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TwoWorkers(unittest.TestCase):
    """Two real processes start together on a database that still holds the
    earlier default: both start, the section ends off, one marker."""

    def test_two_real_workers(self):
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.addCleanup(os.remove, path)
        url = f"sqlite:///{path}"
        self.assertEqual(run_together([STARTUP_CHILD], url), ["started"])   # an install, fully set up
        engine = create_engine(url)
        self.addCleanup(engine.dispose)
        with engine.begin() as c:   # as it was before this release
            c.execute(text("UPDATE settings SET value = 'true' WHERE key = :k"), {"k": KEY})
            c.execute(text("DELETE FROM settings WHERE key = :k"), {"k": MARKER})
        self.assertEqual(run_together([STARTUP_CHILD, STARTUP_CHILD], url), ["started", "started"])
        db = sessionmaker(bind=engine)()
        try:
            self.assertEqual(helpers.get(db, KEY), "false")
            self.assertEqual(db.execute(text("SELECT COUNT(*) FROM settings WHERE key = :k"),
                                        {"k": MARKER}).scalar(), 1)
        finally:
            db.close()
        with engine.begin() as c:   # turned back on, a later start keeps it on
            c.execute(text("UPDATE settings SET value = 'true' WHERE key = :k"), {"k": KEY})
        self.assertEqual(run_together([STARTUP_CHILD], url), ["started"])
        db = sessionmaker(bind=engine)()
        try:
            self.assertEqual(helpers.get(db, KEY), "true")
        finally:
            db.close()


class GaugesFollowNetdata(unittest.TestCase):
    """The header gauges load whenever Netdata is set up, on every page and
    whatever Home's sections are: they are the shell's (js/gauges.js), keyed
    on html[data-netdata] alone, and Home has no part in them."""

    def test_the_gauges_follow_netdata_not_a_section(self):
        static = os.path.join(os.path.dirname(__file__), "..", "static")
        src = open(os.path.join(static, "js", "gauges.js"), encoding="utf-8").read()
        self.assertIn("if (busy || !doc.documentElement.hasAttribute('data-netdata')) return;", src)
        self.assertNotIn("home_sections", src)
        self.assertNotIn("sectionOn", src)
        home = open(os.path.join(static, "js", "pages", "home.js"), encoding="utf-8").read()
        self.assertNotIn("system-stats", home)
        self.assertNotIn("data-netdata", home)


if __name__ == "__main__":
    unittest.main()
