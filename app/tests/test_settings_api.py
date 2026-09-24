"""
GET /api/admin/settings?view=registry and PUT /api/admin/settings/bulk.

Every write is validated against the registry before anything is stored; a
single bad value rejects the whole save with per-key messages (422). The 422
body also carries `detail` (the first message) for the old settings page,
which reads only that.
"""
import unittest
from unittest import mock

try:
    from app.tests import helpers
    from app import settings_registry as reg
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False

USER_KEY = "notify.0123456789abcdef.news"


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SettingsApiBase(unittest.TestCase):
    user = None

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        self.client = helpers.api_client(self.Session, self.user or helpers.ADMIN)

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()
        self.db.close()

    def save(self, *pairs):
        return self.client.put("/api/admin/settings/bulk",
                               json={"settings": [{"key": k, "value": v} for k, v in pairs]})

    def assertRejected(self, r):
        """422 with per-key errors and a string detail equal to the first one."""
        self.assertEqual(r.status_code, 422, r.text)
        body = r.json()
        self.assertIsInstance(body["errors"], dict)
        self.assertTrue(body["errors"])
        self.assertIsInstance(body["detail"], str)
        self.assertEqual(body["detail"], next(iter(body["errors"].values())))
        return body["errors"]


class RegistryView(SettingsApiBase):
    def test_values_and_meta_for_every_active_key(self):
        helpers.put(self.db, "branding.app_name", "My Site")
        helpers.put(self.db, "integration.plex.token", "real-token")
        helpers.put(self.db, "monitor.7.enabled", "false")
        helpers.put(self.db, "system.secret_key", "never-shown")
        r = self.client.get("/api/admin/settings?view=registry")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        for d in reg.active_defs():
            self.assertIn(d.key, body["values"], d.key)
            self.assertIn(d.key, body["meta"], d.key)
        self.assertEqual(body["values"]["branding.app_name"], "My Site")
        self.assertEqual(body["values"]["branding.tagline"], "Media Server Management")  # default, no row
        self.assertEqual(body["values"]["integration.plex.token"], reg.MASK)
        self.assertEqual(body["values"]["integration.seerr.api_key"], "")
        self.assertEqual(body["values"]["monitor.7.enabled"], "false")
        self.assertIn("monitor.{id}.enabled", body["meta"])
        self.assertIn("monitor.{id}.icon", body["meta"])
        self.assertNotIn("system.secret_key", body["values"])
        self.assertNotIn("never-shown", r.text)
        self.assertNotIn("real-token", r.text)
        self.assertNotIn("integration.uptime_kuma.api_key", body["values"])
        self.assertEqual(body["meta"]["news.homepage_count"]["max"], 20)

    def test_view_carries_the_mask_sentinel(self):
        # The front end reads the saved-secret placeholder from here, never a copy of its own.
        helpers.put(self.db, "integration.plex.token", "real-token")
        body = self.client.get("/api/admin/settings?view=registry").json()
        self.assertEqual(body["mask"], reg.MASK)
        self.assertEqual(body["values"]["integration.plex.token"], body["mask"])

    def test_per_user_rows_never_listed(self):
        helpers.put(self.db, USER_KEY, "false")
        for url in ("/api/admin/settings?view=registry", "/api/admin/settings"):
            r = self.client.get(url)
            self.assertEqual(r.status_code, 200, url)
            self.assertNotIn(USER_KEY, r.text, url)
        self.assertEqual(self.client.get("/api/admin/settings/" + USER_KEY).status_code, 404)

    def test_legacy_list_is_kept_until_switch_over(self):
        helpers.put(self.db, "integration.plex.token", "real-token")
        helpers.put(self.db, "system.secret_key", "never-shown")
        r = self.client.get("/api/admin/settings")
        self.assertEqual(r.status_code, 200)
        rows = {row["key"]: row["value"] for row in r.json()}
        self.assertEqual(rows["integration.plex.token"], reg.MASK)
        self.assertEqual(rows["system.secret_key"], reg.MASK)

    def test_single_get_masks_secrets(self):
        helpers.put(self.db, "integration.plex.token", "real-token")
        helpers.put(self.db, "system.secret_key", "never-shown")
        self.assertEqual(self.client.get("/api/admin/settings/integration.plex.token").json()["value"], reg.MASK)
        self.assertEqual(self.client.get("/api/admin/settings/system.secret_key").json()["value"], reg.MASK)


class BulkSave(SettingsApiBase):
    def test_valid_save_writes_and_reports(self):
        r = self.save(("branding.app_name", "Home Cinema"), ("news.homepage_count", "5"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["saved"], ["branding.app_name", "news.homepage_count"])
        self.assertEqual(r.json()["values"], {"branding.app_name": "Home Cinema", "news.homepage_count": "5"})
        self.assertEqual(helpers.get(self.db, "branding.app_name"), "Home Cinema")
        self.assertEqual(helpers.get(self.db, "news.homepage_count"), "5")

    def test_updates_an_existing_row(self):
        helpers.put(self.db, "branding.app_name", "Old")
        r = self.save(("branding.app_name", "New"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(helpers.get(self.db, "branding.app_name"), "New")

    def test_one_bad_value_rejects_the_whole_save(self):
        r = self.save(("branding.app_name", "Home Cinema"), ("integration.sonarr.url", "192.168.1.5:8989"))
        errors = self.assertRejected(r)
        self.assertEqual(list(errors), ["integration.sonarr.url"])
        self.assertIsNone(helpers.get(self.db, "branding.app_name"))

    def test_unknown_and_internal_keys_are_rejected(self):
        r = self.save(("nope.nothing", "x"), ("system.secret_key", "x"))
        errors = self.assertRejected(r)
        self.assertEqual(errors["nope.nothing"], "Unknown setting")
        self.assertIn("system.secret_key", errors)
        self.assertIsNone(helpers.get(self.db, "system.secret_key"))

    def test_per_user_data_is_refused(self):
        helpers.put(self.db, USER_KEY, "true")
        r = self.save(("branding.app_name", "Fine"), (USER_KEY, "false"))
        errors = self.assertRejected(r)
        self.assertEqual(errors[USER_KEY], reg.USER_DATA_MESSAGE)
        self.assertEqual(helpers.get(self.db, USER_KEY), "true")
        self.assertIsNone(helpers.get(self.db, "branding.app_name"))

    def test_duplicate_key_rejected(self):
        r = self.save(("branding.app_name", "A"), ("branding.app_name", "B"))
        errors = self.assertRejected(r)
        self.assertEqual(errors["branding.app_name"], "Listed more than once")
        self.assertIsNone(helpers.get(self.db, "branding.app_name"))

    def test_unstorable_characters_are_422_not_500(self):
        r = self.save(("branding.tagline", "fine"), ("branding.app_name", "Name \ud800"))
        errors = self.assertRejected(r)
        self.assertEqual(errors["branding.app_name"], "Contains characters that can't be stored")
        self.assertIsNone(helpers.get(self.db, "branding.tagline"))

    def test_mask_means_unchanged_for_secrets_only(self):
        helpers.put(self.db, "integration.plex.token", "real-token")
        r = self.save(("integration.plex.token", reg.MASK), ("integration.plex.url", "http://192.168.1.9:32400"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(helpers.get(self.db, "integration.plex.token"), "real-token")
        self.assertNotIn("integration.plex.token", r.json()["saved"])
        r = self.save(("branding.app_name", reg.MASK))
        self.assertRejected(r)
        self.assertIsNone(helpers.get(self.db, "branding.app_name"))

    def test_saved_secret_is_masked_in_the_response(self):
        r = self.save(("integration.seerr.api_key", "abc123"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["values"]["integration.seerr.api_key"], reg.MASK)
        self.assertNotIn("abc123", r.text)
        self.assertEqual(helpers.get(self.db, "integration.seerr.api_key"), "abc123")

    def test_deprecated_key_still_accepted_during_build_alongside(self):
        r = self.save(("integration.uptime_kuma.api_key", "old"))
        self.assertEqual(r.status_code, 200, r.text)

    def test_old_settings_page_save_with_retired_page_keys_still_works(self):
        # Until the old Settings page is replaced (Task 8.3) its Theme save
        # still sends five of the keys the redesign retired, and its Seerr save
        # sends features.show_requests. The whole save must keep working.
        sent_by_old_page = [
            ("sidebar.label_requests_embed", "Requests (Embed)"),
            ("sidebar.enabled_requests_embed", "true"),
            ("sidebar.new_requests_embed", "false"),
            ("icon.nav_requests_embed", "download"),
            ("features.show_tickets", "true"),
            ("features.show_requests", "false"),
        ]
        for key in ("features.show_requests", "features.show_tickets", "features.show_books",
                    "sidebar.label_requests_embed", "sidebar.sublabel_requests_embed",
                    "sidebar.enabled_requests_embed", "sidebar.new_requests_embed", "icon.nav_requests_embed"):
            self.assertTrue(reg.REGISTRY[key].deprecated, key)
        r = self.save(("sidebar.label_home", "Start"), *sent_by_old_page)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(helpers.get(self.db, "sidebar.label_home"), "Start")
        self.assertEqual(helpers.get(self.db, "icon.nav_requests_embed"), "download")

    def test_monitor_pattern_key(self):
        r = self.save(("monitor.12.enabled", "false"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(helpers.get(self.db, "monitor.12.enabled"), "false")

    def test_a_commit_failure_saves_nothing_and_says_so(self):
        from sqlalchemy.orm import Session as SASession
        from app.models import Setting
        real_commit = SASession.commit

        def locked(session):
            # Fails only once the second item is part of the transaction, so a
            # commit-per-item loop would already have saved the first.
            pending = list(session.new) + list(session.dirty)
            if any(isinstance(o, Setting) and o.key == "branding.tagline" for o in pending):
                raise RuntimeError("database is locked")
            return real_commit(session)

        with mock.patch.object(SASession, "commit", autospec=True, side_effect=locked):
            r = self.save(("branding.app_name", "Changed"), ("branding.tagline", "Also"))
        self.assertEqual(r.status_code, 503, r.text)
        self.assertEqual(r.json()["detail"],
                         "Couldn't save the settings right now. Nothing was changed; please try again.")
        self.assertIsNone(helpers.get(self.db, "branding.app_name"))
        self.assertIsNone(helpers.get(self.db, "branding.tagline"))


    def test_a_racing_insert_is_retried_once(self):
        # The other worker inserted the same new key first: the first commit
        # hits the unique key, the retry updates the row instead.
        from sqlalchemy.exc import IntegrityError
        from sqlalchemy.orm import Session as SASession
        real_commit = SASession.commit
        calls = []

        def racing(session):
            calls.append(1)
            if len(calls) == 1:
                raise IntegrityError("INSERT", {}, Exception("UNIQUE constraint failed: settings.key"))
            return real_commit(session)

        with mock.patch.object(SASession, "commit", autospec=True, side_effect=racing):
            r = self.save(("branding.app_name", "Raced"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(calls), 2)
        self.assertEqual(helpers.get(self.db, "branding.app_name"), "Raced")


class LockoutGuard(SettingsApiBase):
    def test_turning_off_the_only_method_is_rejected(self):
        r = self.save(("features.show_simple_auth", "false"))
        errors = self.assertRejected(r)
        self.assertIn("features.show_simple_auth", errors)
        self.assertIsNone(helpers.get(self.db, "features.show_simple_auth"))

    def test_plex_on_but_not_set_up_does_not_count(self):
        r = self.save(("features.show_simple_auth", "false"), ("features.show_plex_auth", "true"))
        self.assertRejected(r)

    def test_switching_to_a_usable_method_is_allowed(self):
        r = self.save(("features.show_simple_auth", "false"), ("features.show_plex_auth", "true"),
                      ("integration.plex.url", "http://192.168.1.9:32400"), ("integration.plex.token", "t"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(helpers.get(self.db, "features.show_simple_auth"), "false")

    def test_clearing_plex_while_it_is_the_only_method_is_rejected(self):
        for k, v in (("features.show_simple_auth", "false"), ("features.show_plex_auth", "true"),
                     ("integration.plex.url", "http://192.168.1.9:32400"), ("integration.plex.token", "t")):
            helpers.put(self.db, k, v)
        r = self.save(("integration.plex.url", ""))
        self.assertRejected(r)
        self.assertEqual(helpers.get(self.db, "integration.plex.url"), "http://192.168.1.9:32400")

    def test_masked_token_counts_as_set(self):
        for k, v in (("features.show_plex_auth", "true"),
                     ("integration.plex.url", "http://192.168.1.9:32400"), ("integration.plex.token", "t")):
            helpers.put(self.db, k, v)
        r = self.save(("features.show_simple_auth", "false"), ("integration.plex.token", reg.MASK))
        self.assertEqual(r.status_code, 200, r.text)

    def _put_all(self, pairs):
        for k, v in pairs:
            helpers.put(self.db, k, v)

    PLEX_READY = (("features.show_plex_auth", "true"),
                  ("integration.plex.url", "http://192.168.1.9:32400"), ("integration.plex.token", "t"))
    AUTHENTIK_READY = (("features.show_authentik_auth", "true"),
                       ("integration.authentik.url", "https://auth.example.com"),
                       ("integration.authentik.client_id", "client"))

    def test_authentik_on_but_not_set_up_does_not_count(self):
        self._put_all(self.PLEX_READY + (("features.show_simple_auth", "false"),
                                         ("features.show_authentik_auth", "true")))
        r = self.save(("features.show_plex_auth", "false"))
        errors = self.assertRejected(r)
        self.assertIn("features.show_plex_auth", errors)
        self.assertEqual(helpers.get(self.db, "features.show_plex_auth"), "true")

    def test_clearing_authentik_while_it_is_the_only_method_is_rejected(self):
        self._put_all(self.AUTHENTIK_READY + (("features.show_simple_auth", "false"),))
        r = self.save(("integration.authentik.url", ""))
        errors = self.assertRejected(r)
        self.assertIn("integration.authentik.url", errors)
        self.assertEqual(helpers.get(self.db, "integration.authentik.url"), "https://auth.example.com")

    def test_authentik_set_up_lets_plex_go(self):
        self._put_all(self.PLEX_READY + self.AUTHENTIK_READY + (("features.show_simple_auth", "false"),))
        r = self.save(("features.show_plex_auth", "false"))
        self.assertEqual(r.status_code, 200, r.text)

    def _race(self, target, other_worker):
        """Run the request with `other_worker` committed between the check and the write,
        the way the second uvicorn worker's save would land."""
        from app.routers import admin_settings
        real_plan = admin_settings.plan_writes

        def plan_then_race(db, items):
            planned = real_plan(db, items)
            self._put_all(other_worker)
            return planned

        return mock.patch(target, side_effect=plan_then_race)

    def test_two_admins_turning_off_different_methods_cannot_both_win(self):
        # Simple and Plex both usable. This admin turns simple off (fine on its
        # own); meanwhile the other worker commits Plex off. Together: nothing.
        self._put_all(self.PLEX_READY)
        with self._race("app.routers.admin_settings.plan_writes", (("features.show_plex_auth", "false"),)):
            r = self.save(("features.show_simple_auth", "false"))
        from app.routers.admin_settings import LOCKOUT_MESSAGE
        self.assertEqual(self.assertRejected(r), {"features.show_simple_auth": LOCKOUT_MESSAGE})
        self.assertIsNone(helpers.get(self.db, "features.show_simple_auth"))
        self.assertEqual(helpers.get(self.db, "features.show_plex_auth"), "false")   # the other save stands

    def test_the_race_is_caught_on_the_single_put_too(self):
        self._put_all(self.PLEX_READY)
        with self._race("app.routers.admin.plan_writes", (("features.show_plex_auth", "false"),)):
            r = self.client.put("/api/admin/settings", json={"key": "features.show_simple_auth", "value": "false"})
        self.assertRejected(r)
        self.assertIsNone(helpers.get(self.db, "features.show_simple_auth"))

    def test_a_race_that_leaves_a_method_is_saved(self):
        self._put_all(self.PLEX_READY)
        with self._race("app.routers.admin_settings.plan_writes", (("branding.app_name", "Other"),)):
            r = self.save(("features.show_simple_auth", "false"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(helpers.get(self.db, "features.show_simple_auth"), "false")

    def test_unrelated_save_is_not_blocked_by_an_existing_bad_state(self):
        helpers.put(self.db, "features.show_simple_auth", "false")
        r = self.save(("branding.app_name", "Fine"))
        self.assertEqual(r.status_code, 200, r.text)


class SingleKeyPut(SettingsApiBase):
    def test_single_put_uses_the_same_validation(self):
        r = self.client.put("/api/admin/settings", json={"key": "theme.color_primary", "value": "red"})
        self.assertRejected(r)
        r = self.client.put("/api/admin/settings", json={"key": "theme.color_primary", "value": "#ff0000"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["value"], "#ff0000")
        self.assertEqual(helpers.get(self.db, "theme.color_primary"), "#ff0000")

    def test_single_put_refuses_internal_and_per_user_keys(self):
        for key in ("system.secret_key", USER_KEY):
            with self.subTest(key=key):
                r = self.client.put("/api/admin/settings", json={"key": key, "value": "x"})
                self.assertRejected(r)
                self.assertIsNone(helpers.get(self.db, key))

    def test_single_put_applies_the_lockout_guard(self):
        r = self.client.put("/api/admin/settings", json={"key": "features.show_simple_auth", "value": "false"})
        self.assertRejected(r)

    def test_single_put_masked_secret_is_unchanged(self):
        helpers.put(self.db, "integration.seerr.api_key", "abc123")
        r = self.client.put("/api/admin/settings", json={"key": "integration.seerr.api_key", "value": reg.MASK})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["value"], reg.MASK)
        self.assertEqual(helpers.get(self.db, "integration.seerr.api_key"), "abc123")

    def test_single_put_commit_failure_is_503(self):
        from sqlalchemy.orm import Session as SASession
        with mock.patch.object(SASession, "commit", autospec=True, side_effect=RuntimeError("database is locked")):
            r = self.client.put("/api/admin/settings", json={"key": "branding.app_name", "value": "X"})
        self.assertEqual(r.status_code, 503, r.text)
        self.assertIsNone(helpers.get(self.db, "branding.app_name"))


class NonAdmin(SettingsApiBase):
    user = helpers.MEMBER if HAVE_APP else None

    def test_members_are_refused(self):
        self.assertEqual(self.client.get("/api/admin/settings?view=registry").status_code, 403)
        self.assertEqual(self.client.get("/api/admin/settings").status_code, 403)
        self.assertEqual(self.save(("branding.app_name", "x")).status_code, 403)
        self.assertIsNone(helpers.get(self.db, "branding.app_name"))


class SignedOut(SettingsApiBase):
    """No session cookie and no user override: the real auth dependency answers."""

    def setUp(self):
        super().setUp()
        from app.dependencies import get_current_user, get_current_user_optional
        from app.main import app
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_current_user_optional, None)

    def test_every_settings_route_needs_a_session(self):
        for method, url, body in (
            ("GET", "/api/admin/settings", None),
            ("GET", "/api/admin/settings?view=registry", None),
            ("PUT", "/api/admin/settings/bulk", {"settings": [{"key": "branding.app_name", "value": "x"}]}),
            ("GET", "/api/admin/settings/branding.app_name", None),
            ("PUT", "/api/admin/settings", {"key": "branding.app_name", "value": "x"}),
        ):
            with self.subTest(method=method, url=url):
                self.assertFalse(self.client.cookies)
                r = self.client.request(method, url, json=body)
                self.assertEqual(r.status_code, 401, r.text)
        self.assertIsNone(helpers.get(self.db, "branding.app_name"))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class HelpersRestoreTheLimiter(unittest.TestCase):
    def test_reset_puts_back_the_previous_state(self):
        from app.limiter import limiter
        was = limiter.enabled
        try:
            for before in (True, False):
                limiter.enabled = before
                helpers.api_client(helpers.make_sessionmaker())
                helpers.api_client(helpers.make_sessionmaker())   # a second call must not lose the saved state
                self.assertFalse(limiter.enabled)
                helpers.reset_overrides()
                self.assertEqual(limiter.enabled, before)
        finally:
            helpers.reset_overrides()
            limiter.enabled = was


if __name__ == "__main__":
    unittest.main()
