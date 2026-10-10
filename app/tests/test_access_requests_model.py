"""
Request access, the database half (docs/superpowers/specs/2026-10-10-request-access-design.md,
sections 4 and 5): the two settings and their checks, the sign-in page's flag, the server-side gate,
the form rules, the per-account state, the submit rules (blocked, cooldown, one open request, the cap
of 20) and the tidy.
"""
import inspect
import json
import unittest
from datetime import timedelta

try:
    import sqlalchemy  # noqa: F401
    from fastapi import FastAPI  # noqa: F401
    HAVE_APP = True
except ImportError:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

if HAVE_APP:
    from app import settings_registry as reg
    from app.models import AccessRequest
    from app.routers import branding
    from app.services import access_requests as svc
    from app.services import notification_poller
    from app.tests import helpers

ACCOUNT = {"plex_account_id": "5551", "plex_username": "newperson", "plex_email": "new@example.com",
           "plex_avatar_url": "https://plex.tv/users/abc/avatar?c=1"}


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class SettingsKeys(unittest.TestCase):
    def test_the_switch_is_off_by_default_and_public(self):
        d = reg.REGISTRY["access_requests.enabled"]
        self.assertEqual((d.type, d.default, d.public, d.secret), ("bool", "false", True, False))
        self.assertIn("access_requests.enabled", reg.seed_defaults())

    def test_default_libraries_is_a_private_list_of_section_keys(self):
        key = "access_requests.default_libraries"
        d = reg.REGISTRY[key]
        self.assertEqual((d.type, d.default, d.public, d.max_length), ("json", "[]", False, 2000))
        for good in ('[]', '["1"]', '["1", "22", "4096"]', '["1234567890"]'):
            self.assertIsNone(reg.validate_value(key, good), good)
        for bad in ('{}', '"1"', '[1]', '["a"]', '["1x"]', '["12345678901"]', '["1", "1"]', '["-1"]',
                    'not json', '[" 1"]', '["١"]', ''):
            self.assertIsNotNone(reg.validate_value(key, bad), bad)
        too_long = json.dumps([str(1000000 + i) for i in range(250)])
        self.assertGreater(len(too_long), 2000)
        self.assertIsNotNone(reg.validate_value(key, too_long))


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class BrandingFlag(unittest.TestCase):
    def flag(self, enabled, url="http://192.168.1.2:32400", token="t"):
        values = {} if enabled is None else {"access_requests.enabled": enabled}
        auth = {"integration.plex.url": url, "integration.plex.token": token}
        payload = branding.build_branding(values, auth, None, dict(branding.EMPTY_WIKI_HOOKS))
        return payload["auth_methods"]["request_access"]

    def test_on_only_with_the_switch_and_plex(self):
        self.assertIs(self.flag(None), False)
        self.assertIs(self.flag("false"), False)
        self.assertIs(self.flag("true"), True)
        self.assertIs(self.flag("true", url=""), False)
        self.assertIs(self.flag("true", token=""), False)


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class WithDatabase(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.addCleanup(self.db.close)
        self.now = svc.now_utc().replace(microsecond=0)

    def row(self, account_id, status, created_at=None, **kw):
        r = AccessRequest(plex_account_id=account_id, plex_username="u" + account_id, name="N", note="n",
                          status=status, created_at=created_at or self.now, **kw)
        self.db.add(r)
        self.db.commit()
        return r

    def count(self, **filters):
        return self.db.query(AccessRequest).filter_by(**filters).count()


class Gate(WithDatabase):
    def test_open_only_with_the_switch_the_address_and_the_token(self):
        self.assertFalse(svc.is_open(self.db))
        helpers.put(self.db, "access_requests.enabled", "true")
        self.assertFalse(svc.is_open(self.db))
        helpers.put(self.db, "integration.plex.url", "http://192.168.1.2:32400")
        self.assertFalse(svc.is_open(self.db))
        helpers.put(self.db, "integration.plex.token", "t")
        self.assertTrue(svc.is_open(self.db))
        helpers.put(self.db, "access_requests.enabled", "false")
        self.assertFalse(svc.is_open(self.db))


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class Avatar(unittest.TestCase):
    def test_only_https_plex_tv_hosts(self):
        for good in ("https://plex.tv/users/abc/avatar?c=1", "https://assets.plex.tv/a.png",
                     "HTTPS://Plex.TV/users/x"):
            self.assertEqual(svc.safe_avatar_url(good), good, good)
        for bad in ("http://plex.tv/users/abc/avatar", "https://plex.tv.evil.example/x", "https://evilplex.tv/x",
                    "javascript:alert(1)", "", None, 7, "https://user@plex.tv/x", "https://plex.tv/a b",
                    "https://plex.tv/" + "a" * 500, "//plex.tv/x", "https://plex.tv:99999/x"):
            self.assertEqual(svc.safe_avatar_url(bad), "", repr(bad))


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class Form(unittest.TestCase):
    def test_trimmed_and_kept(self):
        self.assertEqual(svc.clean_form("  Sam Lee ", " Friend of Ana.\r\nWe met at work. "),
                         ("Sam Lee", "Friend of Ana.\nWe met at work."))
        self.assertEqual(svc.clean_form("Zoë 🎬", "x" * 1000), ("Zoë 🎬", "x" * 1000))
        # Enter at the end of the note, a pasted trailing tab: trimmed, not refused.
        self.assertEqual(svc.clean_form("Sam", "Hello.\n"), ("Sam", "Hello."))
        self.assertEqual(svc.clean_form("Sam", "Hello.\r\n"), ("Sam", "Hello."))
        self.assertEqual(svc.clean_form("Sam\t", "Hello."), ("Sam", "Hello."))

    def test_refused(self):
        cases = [("", "note", svc.NAME_PROBLEM), ("   ", "note", svc.NAME_PROBLEM),
                 ("n" * 81, "note", svc.NAME_PROBLEM), ("Sam\tLee", "note", svc.NAME_PROBLEM),
                 ("Sam\nLee", "note", svc.NAME_PROBLEM), ("Sam\x85", "note", svc.NAME_PROBLEM),
                 ("Sam", "", svc.NOTE_PROBLEM),
                 ("Sam", "x" * 1001, svc.NOTE_PROBLEM), ("Sam", "bell\x07", svc.NOTE_PROBLEM),
                 ("Sam", "c1\x85", svc.NOTE_PROBLEM), ("Sam", "\x1fnote", svc.NOTE_PROBLEM),
                 ("Sam", "tab\tinside", svc.NOTE_PROBLEM)]
        for name, note, message in cases:
            with self.subTest(name=name[:10], note=note[:10]):
                with self.assertRaises(svc.FormProblem) as caught:
                    svc.clean_form(name, note)
                self.assertEqual(str(caught.exception), message)


class States(WithDatabase):
    def test_each_state(self):
        self.assertEqual(svc.state_for(self.db, "1", self.now), {"state": "new"})
        self.row("2", "pending")
        self.assertEqual(svc.state_for(self.db, "2", self.now)["state"], "pending")
        self.assertTrue(svc.state_for(self.db, "2", self.now)["submitted_at"].endswith("Z"))
        self.row("3", "approved", decided_at=self.now)
        self.assertEqual(svc.state_for(self.db, "3", self.now)["state"], "approved")
        self.row("4", "denied", decided_at=self.now, cooldown_until=self.now + timedelta(days=30))
        denied = svc.state_for(self.db, "4", self.now)
        self.assertEqual(denied["state"], "denied")
        self.assertTrue(denied["can_ask_after"].startswith(str((self.now + timedelta(days=30)).date())))
        self.row("5", "blocked", decided_at=self.now)
        self.assertEqual(svc.state_for(self.db, "5", self.now)["state"], "blocked")

    def test_a_cooldown_that_ended_reads_as_new(self):
        self.row("6", "denied", decided_at=self.now - timedelta(days=31), cooldown_until=self.now - timedelta(days=1))
        self.assertEqual(svc.state_for(self.db, "6", self.now), {"state": "new"})


class Place(WithDatabase):
    def place(self, account=None):
        return svc.place(self.db, account or ACCOUNT, "New Person", "A friend of Sam.", self.now)

    def test_a_new_account_gets_a_pending_row(self):
        result, row = self.place()
        self.assertEqual(result, {"state": "pending", "sent": True})
        self.assertEqual((row.status, row.plex_account_id, row.plex_username, row.name, row.note),
                         ("pending", "5551", "newperson", "New Person", "A friend of Sam."))
        self.assertEqual(row.plex_avatar_url, "https://plex.tv/users/abc/avatar?c=1")

    def test_an_unsafe_avatar_is_stored_empty(self):
        _, row = self.place({**ACCOUNT, "plex_avatar_url": "http://evil.example/a.png"})
        self.assertEqual(row.plex_avatar_url, "")

    def test_one_open_request_per_account(self):
        self.place()
        result, row = self.place()
        self.assertIsNone(row)
        self.assertEqual((result["state"], result["sent"]), ("pending", False))
        self.assertEqual(self.count(plex_account_id="5551"), 1)

    def test_approved_blocked_and_cooldown_answer_with_their_state(self):
        for status, extra in (("approved", {"decided_at": self.now}),
                              ("blocked", {"decided_at": self.now}),
                              ("denied", {"decided_at": self.now, "cooldown_until": self.now + timedelta(days=3)})):
            with self.subTest(status):
                self.db.query(AccessRequest).delete()
                self.db.commit()
                self.row("5551", status, **extra)
                result, row = self.place()
                self.assertIsNone(row)
                self.assertEqual((result["state"], result["sent"]), (status, False))
                self.assertEqual(self.count(), 1)

    def test_a_denied_row_whose_cooldown_ended_is_replaced(self):
        self.row("5551", "denied", decided_at=self.now - timedelta(days=31), cooldown_until=self.now - timedelta(seconds=1))
        result, row = self.place()
        self.assertEqual(result, {"state": "pending", "sent": True})
        self.assertEqual(self.count(plex_account_id="5551"), 1)
        self.assertEqual(row.status, "pending")

    def test_the_cap_counts_pending_only(self):
        for i in range(svc.OPEN_CAP):
            self.row(str(9000 + i), "approved", decided_at=self.now)
        self.assertEqual(self.place()[0]["sent"], True)

    def test_the_cap_refuses_the_twenty_first_and_keeps_an_old_denied_row(self):
        for i in range(svc.OPEN_CAP):
            self.row(str(9000 + i), "pending")
        self.row("5551", "denied", decided_at=self.now - timedelta(days=31), cooldown_until=self.now - timedelta(days=1))
        with self.assertRaises(svc.CapReached):
            self.place()
        self.assertEqual(self.count(plex_account_id="5551", status="denied"), 1)
        self.assertEqual(self.count(status="pending"), svc.OPEN_CAP)


class Tidy(WithDatabase):
    def test_what_goes_and_what_stays(self):
        day = timedelta(days=1)
        self.row("1", "denied", decided_at=self.now - 31 * day, cooldown_until=self.now - day)        # goes
        self.row("2", "denied", decided_at=self.now - day, cooldown_until=self.now + 29 * day)        # stays
        self.row("3", "approved", decided_at=self.now - 31 * day)                                     # goes
        self.row("4", "approved", decided_at=self.now - 29 * day)                                     # stays
        self.row("5", "blocked", decided_at=self.now - 400 * day)                                     # stays
        self.row("6", "pending", created_at=self.now - 400 * day)                                     # stays
        self.assertEqual(svc.tidy(self.db, self.now), 2)
        left = sorted(r.plex_account_id for r in self.db.query(AccessRequest).all())
        self.assertEqual(left, ["2", "4", "5", "6"])

    def test_the_leader_loop_tidies_hourly(self):
        src = inspect.getsource(notification_poller._poll_forever)
        self.assertIn("access_requests.tidy(", src)
        self.assertIn("access_requests.TIDY_INTERVAL", src)
        self.assertEqual(svc.TIDY_INTERVAL, 3600)


class UsernameFlagMigration(WithDatabase):
    def test_an_existing_table_gets_the_column_once_and_old_rows_count_as_usernames(self):
        from sqlalchemy import text
        from app.seed import migrate_access_request_username_flag
        self.row("1", "pending")
        self.db.execute(text("ALTER TABLE access_requests DROP COLUMN has_plex_username"))   # the old shape
        self.db.commit()
        with self.assertLogs("app.seed", level="INFO"):
            migrate_access_request_username_flag(self.db)
        with self.assertNoLogs("app.seed", level="INFO"):
            migrate_access_request_username_flag(self.db)      # once: nothing left to do
        self.db.expire_all()
        self.assertIs(self.db.query(AccessRequest).one().has_plex_username, True)

    def test_startup_runs_it(self):
        from app import database
        self.assertIn("migrate_access_request_username_flag(db)", inspect.getsource(database))


if __name__ == "__main__":
    unittest.main()
