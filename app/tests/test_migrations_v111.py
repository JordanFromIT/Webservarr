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

    def test_only_an_explicit_false_flag_counts_as_off(self):
        # "1" is not "false": the switch is left exactly as it was.
        for migrate, flag_key, switch_key in (
            (seed.migrate_tickets_page_switch_v1, "features.show_tickets", "sidebar.enabled_tickets"),
            (seed.migrate_ebooks_page_switch_v1, "features.show_books", "sidebar.enabled_library"),
        ):
            self.run_case(migrate, flag_key, switch_key, "1", "true", "true")

    def test_a_switch_that_is_not_false_counts_as_on(self):
        # A flag of "false" turns off any switch not already "false", including "1".
        for migrate, flag_key, switch_key in (
            (seed.migrate_tickets_page_switch_v1, "features.show_tickets", "sidebar.enabled_tickets"),
            (seed.migrate_ebooks_page_switch_v1, "features.show_books", "sidebar.enabled_library"),
        ):
            self.run_case(migrate, flag_key, switch_key, "false", "1", "false")


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

    # Values that are neither "true" nor "false" pin each operator as documented:
    # the two switches count as on unless "false", the embed flag only when "true".
    def test_native_switch_counts_as_on_unless_false(self):
        self.setup_state(native_on=True, embed_on=True)
        helpers.put(self.db, "sidebar.enabled_requests", "1")
        seed.migrate_requests_source_v1(self.db)
        self.assertEqual(helpers.get(self.db, "requests.source"), "native")
        self.assertEqual(helpers.get(self.db, "sidebar.enabled_requests"), "1")

    def test_embed_switch_counts_as_on_unless_false(self):
        self.setup_state(native_on=False, embed_on=True)
        helpers.put(self.db, "sidebar.enabled_requests_embed", "1")
        seed.migrate_requests_source_v1(self.db)
        self.check("seerr_embed", True)

    def test_embed_flag_counts_as_on_only_when_true(self):
        self.setup_state(native_on=False, embed_on=True)
        helpers.put(self.db, "features.show_requests", "1")
        seed.migrate_requests_source_v1(self.db)
        self.check("native", False)


class InitDbSequence(MigrationBase):
    """All three migrations on one seeded database, in init_db's order."""

    def test_the_three_migrations_run_together(self):
        seed.seed_default_settings(self.db)
        helpers.put(self.db, "features.show_tickets", "false")
        helpers.put(self.db, "features.show_books", "false")
        helpers.put(self.db, "sidebar.enabled_requests", "false")
        helpers.put(self.db, "features.show_requests", "true")
        helpers.put(self.db, "sidebar.enabled_requests_embed", "true")

        seed.migrate_tickets_page_switch_v1(self.db)
        seed.migrate_ebooks_page_switch_v1(self.db)
        seed.migrate_requests_source_v1(self.db)

        self.assertEqual(helpers.get(self.db, "sidebar.enabled_tickets"), "false")
        self.assertEqual(helpers.get(self.db, "sidebar.enabled_library"), "false")
        self.assertEqual(helpers.get(self.db, "requests.source"), "seerr_embed")
        self.assertEqual(helpers.get(self.db, "sidebar.enabled_requests"), "true")
        for marker in ("migration.tickets_page_switch_v1", "migration.ebooks_page_switch_v1",
                       "migration.requests_source_v1"):
            self.assertEqual(helpers.get(self.db, marker), "done", marker)


if __name__ == "__main__":
    unittest.main()
