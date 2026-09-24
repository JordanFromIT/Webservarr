"""
v1.11 migrations: one switch per page, and the Requests source.

Each migration only changes rows that still hold what it expects, runs once
(marker row), and never overwrites a value an admin chose.
"""
import unittest

try:
    from app.tests import helpers
    from app import seed
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class MigrationBase(unittest.TestCase):
    def setUp(self):
        self.db = helpers.make_sessionmaker()()

    def tearDown(self):
        self.db.close()

    def rows(self, **values):
        for key, value in values.items():
            helpers.put(self.db, key.replace("__", "."), value)


class PageSwitches(MigrationBase):
    CASES = [
        # (flag, switch before, switch after)
        ("true", "true", "true"),
        ("true", "false", "false"),
        ("false", "true", "false"),
        ("false", "false", "false"),
        (None, "true", "true"),       # fresh install: no flag row
        ("false", None, "false"),     # flag off, switch row never written
    ]

    def run_case(self, migrate, flag_key, switch_key, flag, before, after):
        db = helpers.make_sessionmaker()()
        try:
            if flag is not None:
                helpers.put(db, flag_key, flag)
            if before is not None:
                helpers.put(db, switch_key, before)
            migrate(db)
            migrate(db)   # idempotent
            got = helpers.get(db, switch_key)
            self.assertEqual(got if got is not None else "true", after, (flag, before))
        finally:
            db.close()

    def test_tickets_every_combination(self):
        for flag, before, after in self.CASES:
            self.run_case(seed.migrate_tickets_page_switch_v1, "features.show_tickets",
                          "sidebar.enabled_tickets", flag, before, after)

    def test_ebooks_every_combination(self):
        for flag, before, after in self.CASES:
            self.run_case(seed.migrate_ebooks_page_switch_v1, "features.show_books",
                          "sidebar.enabled_library", flag, before, after)

    def test_runs_once_even_if_the_admin_changes_things_later(self):
        helpers.put(self.db, "features.show_tickets", "false")
        helpers.put(self.db, "sidebar.enabled_tickets", "true")
        seed.migrate_tickets_page_switch_v1(self.db)
        self.assertEqual(helpers.get(self.db, "sidebar.enabled_tickets"), "false")
        helpers.put(self.db, "sidebar.enabled_tickets", "true")   # admin turns it back on
        seed.migrate_tickets_page_switch_v1(self.db)
        self.assertEqual(helpers.get(self.db, "sidebar.enabled_tickets"), "true")
        self.assertEqual(helpers.get(self.db, "migration.tickets_page_switch_v1"), "done")


class RequestsSource(MigrationBase):
    """Spec section 7, migration 3 - the four-row table, exactly."""

    def setup_state(self, native_on, embed_on):
        # Seeding has already run on every real install, so requests.source
        # holds its default when the migration first sees it.
        helpers.put(self.db, "requests.source", "native")
        helpers.put(self.db, "sidebar.enabled_requests", "true" if native_on else "false")
        helpers.put(self.db, "features.show_requests", "true" if embed_on else "false")
        helpers.put(self.db, "sidebar.enabled_requests_embed", "true")
        helpers.put(self.db, "sidebar.label_requests", "Ask for it")
        helpers.put(self.db, "sidebar.label_requests_embed", "Seerr page")

    def check(self, source, requests_on):
        self.assertEqual(helpers.get(self.db, "requests.source"), source)
        self.assertEqual(helpers.get(self.db, "sidebar.enabled_requests"), "true" if requests_on else "false")
        # The Requests row keeps the native row's label.
        self.assertEqual(helpers.get(self.db, "sidebar.label_requests"), "Ask for it")

    def test_native_on_embed_off(self):
        self.setup_state(native_on=True, embed_on=False)
        seed.migrate_requests_source_v1(self.db)
        self.check("native", True)

    def test_native_on_embed_on(self):
        self.setup_state(native_on=True, embed_on=True)
        seed.migrate_requests_source_v1(self.db)
        self.check("native", True)

    def test_native_off_embed_on(self):
        self.setup_state(native_on=False, embed_on=True)
        seed.migrate_requests_source_v1(self.db)
        self.check("seerr_embed", True)

    def test_native_off_embed_off(self):
        self.setup_state(native_on=False, embed_on=False)
        seed.migrate_requests_source_v1(self.db)
        self.check("native", False)

    def test_embed_hidden_by_its_own_switch_counts_as_off(self):
        self.setup_state(native_on=False, embed_on=True)
        helpers.put(self.db, "sidebar.enabled_requests_embed", "false")
        seed.migrate_requests_source_v1(self.db)
        self.check("native", False)

    def test_missing_rows_mean_todays_defaults(self):
        seed.migrate_requests_source_v1(self.db)     # nothing stored at all
        self.assertEqual(helpers.get(self.db, "requests.source"), "native")
        self.assertIsNone(helpers.get(self.db, "sidebar.enabled_requests"))

    def test_idempotent_and_never_overwrites_a_choice(self):
        self.setup_state(native_on=False, embed_on=True)
        seed.migrate_requests_source_v1(self.db)
        helpers.put(self.db, "requests.source", "native")          # admin switches back
        seed.migrate_requests_source_v1(self.db)
        self.assertEqual(helpers.get(self.db, "requests.source"), "native")

    def test_an_already_chosen_source_is_left_alone(self):
        self.setup_state(native_on=True, embed_on=False)
        helpers.put(self.db, "requests.source", "seerr_embed")     # chosen before the migration ran
        seed.migrate_requests_source_v1(self.db)
        self.assertEqual(helpers.get(self.db, "requests.source"), "seerr_embed")


if __name__ == "__main__":
    unittest.main()
