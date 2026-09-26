"""
GET /api/admin/settings (SettingsView) and PUT /api/admin/settings/bulk.

Every write is validated against the registry before anything is stored; a
single bad value rejects the whole save with per-key messages (422). The 422
body also carries `detail`, a copy of the first message.
"""
import os
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

    def test_view_carries_the_page_order_and_addresses(self):
        # R14: the Pages tab shows the order the server renders and the fixed
        # page addresses, both from here; it keeps no copy of either.
        body = self.client.get("/api/admin/settings?view=registry").json()
        self.assertEqual(body["page_order"], reg.DEFAULT_PAGE_ORDER)
        self.assertEqual(body["page_addresses"], reg.PAGE_ADDRESSES)
        self.assertEqual(list(body["page_addresses"]), list(reg.SIDEBAR_PAGE_IDS))
        # Each address is a page the app really serves.
        from app.main import app
        served = {r.path for r in app.routes if "GET" in (getattr(r, "methods", None) or ())}
        for pid, path in reg.PAGE_ADDRESSES.items():
            self.assertIn(path, served, pid)
        # A stale or hand-edited row is normalised exactly as the nav does it;
        # the raw value is still what `values` holds.
        stale = '["wiki", "settings", "bogus", "home", "wiki", "requests"]'
        helpers.put(self.db, "pages.order", stale)
        body = self.client.get("/api/admin/settings?view=registry").json()
        self.assertEqual(body["page_order"], reg.normalize_page_order(stale))
        self.assertEqual(body["page_order"], ["home", "wiki", "requests", "issues", "calendar", "tickets",
                                              "library", "settings"])
        self.assertEqual(body["values"]["pages.order"], stale)
        helpers.put(self.db, "pages.order", "not json")
        body = self.client.get("/api/admin/settings?view=registry").json()
        self.assertEqual(body["page_order"], reg.DEFAULT_PAGE_ORDER)

    def test_per_user_rows_never_listed(self):
        helpers.put(self.db, USER_KEY, "false")
        for url in ("/api/admin/settings?view=registry", "/api/admin/settings"):
            r = self.client.get(url)
            self.assertEqual(r.status_code, 200, url)
            self.assertNotIn(USER_KEY, r.text, url)

    def test_default_view_is_the_registry(self):
        body = self.client.get("/api/admin/settings").json()
        self.assertIn("values", body)
        self.assertIn("meta", body)

    def test_default_view_is_masked_and_leaves_internal_rows_out(self):
        # The old row list masked internal secrets by name; the view never lists them at all.
        helpers.put(self.db, "integration.plex.token", "real-token")
        helpers.put(self.db, "system.secret_key", "never-shown")
        helpers.put(self.db, "features.show_tickets", "false")      # a retired key's leftover row
        from app.routers.setup import SETUP_TOKEN_KEY
        helpers.put(self.db, SETUP_TOKEN_KEY, "setup-token-value")
        r = self.client.get("/api/admin/settings")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["values"]["integration.plex.token"], reg.MASK)
        self.assertNotIn("system.secret_key", body["values"])
        self.assertNotIn("features.show_tickets", body["values"])
        self.assertNotIn("real-token", r.text)
        self.assertNotIn("never-shown", r.text)
        self.assertNotIn(SETUP_TOKEN_KEY, body["values"])
        self.assertNotIn("setup-token-value", r.text)


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

    def test_retired_keys_are_rejected(self):
        r = self.save(("features.show_tickets", "false"))
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["errors"]["features.show_tickets"], "Unknown setting")

    def test_a_save_carrying_a_retired_key_writes_nothing(self):
        r = self.save(("sidebar.label_home", "Start"), ("integration.uptime_kuma.api_key", "old"),
                      ("icon.nav_requests_embed", "download"))
        errors = self.assertRejected(r)
        self.assertEqual(errors, {"integration.uptime_kuma.api_key": "Unknown setting",
                                  "icon.nav_requests_embed": "Unknown setting"})
        self.assertIsNone(helpers.get(self.db, "sidebar.label_home"))
        self.assertIsNone(helpers.get(self.db, "icon.nav_requests_embed"))

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


class NonAdmin(SettingsApiBase):
    user = helpers.MEMBER if HAVE_APP else None

    def test_members_are_refused(self):
        self.assertEqual(self.client.get("/api/admin/settings?view=registry").status_code, 403)
        self.assertEqual(self.client.get("/api/admin/settings").status_code, 403)
        self.assertEqual(self.save(("branding.app_name", "x")).status_code, 403)
        self.assertIsNone(helpers.get(self.db, "branding.app_name"))
        self.assertEqual(self.client.get("/api/admin/settings/shell").status_code, 403)


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
            ("GET", "/api/admin/settings/shell", None),
        ):
            with self.subTest(method=method, url=url):
                self.assertFalse(self.client.cookies)
                r = self.client.request(method, url, json=body)
                self.assertEqual(r.status_code, 401, r.text)
        self.assertIsNone(helpers.get(self.db, "branding.app_name"))


class RemovedRoutes(SettingsApiBase):
    """Admin routes removed in v1.11 because nothing called them any more.

    Each now answers 404 (no such path) or 405 (the path serves another
    method), never a 500, whoever asks."""

    REMOVED = (
        ("GET", "/api/admin/settings/branding.app_name", None),
        ("PUT", "/api/admin/settings", {"key": "branding.app_name", "value": "x"}),
        ("PUT", "/api/admin/monitors/7", {"enabled": False, "icon": "x"}),
        ("POST", "/api/admin/restart-container", None),
        ("POST", "/api/admin/shutdown-container", None),
    )

    def _check(self):
        # A stored row, so the old single-key GET would have found something.
        helpers.put(self.db, "branding.app_name", "Kept")
        for method, url, body in self.REMOVED:
            with self.subTest(method=method, url=url):
                r = self.client.request(method, url, json=body)
                self.assertIn(r.status_code, (404, 405), r.text)
                self.assertNotIn("Kept", r.text)
        self.assertEqual(helpers.get(self.db, "branding.app_name"), "Kept")
        self.assertIsNone(helpers.get(self.db, "monitor.7.enabled"))
        self.assertIsNone(helpers.get(self.db, "monitor.7.icon"))

    def test_removed_routes_are_gone_for_admins(self):
        self._check()

    def test_removed_routes_are_gone_when_signed_out(self):
        from app.dependencies import get_current_user, get_current_user_optional
        from app.main import app
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_current_user_optional, None)
        self._check()

    def test_the_removed_handlers_and_their_models_are_deleted(self):
        from app.routers import admin
        self.assertFalse(hasattr(admin, "CONTAINER_NAME"))
        for name in ("restart_container", "shutdown_container", "update_monitor_preferences",
                     "get_setting", "update_setting", "SettingCreate", "MonitorPreferences"):
            self.assertFalse(hasattr(admin, name), name)


class ShellPatch(SettingsApiBase):
    """GET /api/admin/settings/shell: the sidebar links as every page renders
    them now, for the Settings page to swap in after a save that changes them."""

    def test_shell_fragment_reflects_saved_nav_settings(self):
        r = self.save(("sidebar.label_issues", "Problems"),
                      ("pages.order", '["home","wiki","requests","issues","calendar","tickets","library","settings"]'))
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.get("/api/admin/settings/shell")
        self.assertEqual(r.status_code, 200, r.text)
        nav = r.json()["nav_html"]
        self.assertIn("Problems", nav)
        self.assertLess(nav.index('href="/wiki"'), nav.index('href="/requests"'))
        self.assertRegex(nav, r'<a[^>]*href="/settings"[^>]*aria-current="page"')

    def test_not_shadowed_by_a_key_route(self):
        # A GET /settings/{key} route (admin.router had one until v1.11)
        # would answer 404 for "shell" if it were matched first.
        r = self.client.get("/api/admin/settings/shell")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(set(r.json()), {"nav_html"})

    def test_fragment_is_the_page_renderer_output(self):
        # Same renderer, same branding, same active page as /settings, so
        # the patched sidebar cannot drift from a reloaded one: the requests
        # badge is kept and the links carry no id (they fill two navs).
        from app.pages import render_nav_links
        from app.routers.branding import load_branding
        r = self.save(("icon.nav_issues", "bug_report"), ("sidebar.label_wiki", "Help & <Guides>"))
        self.assertEqual(r.status_code, 200, r.text)
        nav = self.client.get("/api/admin/settings/shell").json()["nav_html"]
        self.assertEqual(nav, render_nav_links(load_branding(self.db, True), True, "settings"))
        self.assertIn(">bug_report<", nav)
        self.assertIn("Help &amp; &lt;Guides&gt;", nav)
        self.assertNotIn("<Guides>", nav)
        self.assertRegex(nav, r'href="/requests"[^\n]*data-badge="requestsBadge"')
        self.assertNotRegex(nav, r"""\sid=["']""")


class LogoUpload(SettingsApiBase):
    PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64

    def test_upload_stores_the_file_but_not_the_setting(self):
        import tempfile
        from app.routers import admin
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(admin, "UPLOAD_DIR", tmp):
            r = self.client.post("/api/admin/upload-logo", files={"file": ("logo.png", self.PNG, "image/png")})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertTrue(r.json()["url"].startswith("/static/uploads/logo-"))
            self.assertEqual(len(os.listdir(tmp)), 1)
        self.assertIsNone(helpers.get(self.db, "branding.logo_url"))

    def test_upload_leaves_a_stored_logo_alone_until_save(self):
        # The page stages the returned URL; only Save (BulkSave) writes it.
        import tempfile
        from app.routers import admin
        helpers.put(self.db, "branding.logo_url", "/static/uploads/logo-current.png")
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(admin, "UPLOAD_DIR", tmp):
            r = self.client.post("/api/admin/upload-logo", files={"file": ("logo.png", self.PNG, "image/png")})
            self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(helpers.get(self.db, "branding.logo_url"), "/static/uploads/logo-current.png")
        r = self.save(("branding.logo_url", r.json()["url"]))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(helpers.get(self.db, "branding.logo_url").startswith("/static/uploads/logo-"))
        self.assertNotEqual(helpers.get(self.db, "branding.logo_url"), "/static/uploads/logo-current.png")


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



class ValidationOffTheLoop(SettingsApiBase):
    """Validating an address can resolve a hostname with a blocking lookup, so
    BulkSave and SettingsImport validate in a worker
    thread: a slow DNS server must not freeze the worker's event loop for
    every other request."""

    def _spy(self):
        import asyncio
        seen = []

        def is_safe(url):
            try:
                asyncio.get_running_loop()
                seen.append(("loop", url))
            except RuntimeError:
                seen.append(("thread", url))
            return True
        return seen, mock.patch("app.utils.is_safe_integration_url", side_effect=is_safe)

    def test_bulk_save_validates_off_the_event_loop(self):
        seen, spy = self._spy()
        with spy:
            r = self.save(("integration.sonarr.url", "http://sonarr.lan:8989"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(seen, [("thread", "http://sonarr.lan:8989")])

    def test_import_validates_off_the_event_loop(self):
        data = {"format": "webservarr-settings", "format_version": 1,
                "settings": {"integration.radarr.url": "http://radarr.lan:7878"}}
        seen, spy = self._spy()
        with spy:
            preview = self.client.post("/api/admin/settings/import?dry_run=true", json={"data": data})
            self.assertEqual(preview.status_code, 200, preview.text)
            r = self.client.post("/api/admin/settings/import?dry_run=false",
                                 json={"data": data, "diff_token": preview.json()["diff_token"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(helpers.get(self.db, "integration.radarr.url"), "http://radarr.lan:7878")
        self.assertTrue(seen)
        self.assertEqual({where for where, _url in seen}, {"thread"})


class PushStatusBase(SettingsApiBase):
    """Fixtures for GET /api/admin/notifications/status (PushStatus) and the recorded last push.

    The last push lives in Redis so both uvicorn workers report the same one;
    every test here swaps in a fake so nothing touches the dev instance's Redis."""

    STATUS_KEYS = {"push_ready", "reason", "devices", "users", "recipients", "last_push"}

    def setUp(self):
        super().setUp()
        self.store = {}
        store = self.store

        class FakeRedis:
            async def set(self, key, value, **kw):
                store[key] = value

            async def get(self, key):
                return store.get(key)

        self.redis_patch = mock.patch("app.auth.session_manager.get_redis",
                                      mock.AsyncMock(return_value=FakeRedis()))
        self.redis_patch.start()

    def tearDown(self):
        self.redis_patch.stop()
        super().tearDown()

    def add_sub(self, email, n):
        from app.models import PushSubscription
        self.db.add(PushSubscription(user_email=email, endpoint=f"https://push.example.com/{email}/{n}",
                                     p256dh="p", auth="a"))
        self.db.commit()

    def add_notification(self, email, days_ago):
        from datetime import datetime, timedelta
        from app.models import Notification
        self.db.add(Notification(user_email=email, category="news", title="t", body="b",
                                 created_at=datetime.utcnow() - timedelta(days=days_ago)))
        self.db.commit()

    def seed_keys(self):
        from app.seed import seed_vapid_keys
        seed_vapid_keys(self.db)

    def status(self):
        r = self.client.get("/api/admin/notifications/status")
        self.assertEqual(r.status_code, 200, r.text)
        return r

    def _dispatch(self, emails, category="news", webpush=None):
        """Run the real dispatch_push against the test DB with the HTTP send faked."""
        import asyncio
        import pywebpush
        from app.services import push
        if webpush is None:
            webpush = mock.Mock(return_value=None)
        with mock.patch.object(push, "SessionLocal", self.Session), \
             mock.patch.object(push, "is_safe_push_endpoint", return_value=True), \
             mock.patch.object(pywebpush, "webpush", webpush):
            return asyncio.run(push.dispatch_push(emails, "Title", "Body", category, "/"))


class PushStatusApi(PushStatusBase):
    # --- the endpoint ---------------------------------------------------

    def test_not_ready_without_keys(self):
        from app.services import push
        with mock.patch.object(push, "read_last_push", mock.AsyncMock(return_value=None)):
            body = self.status().json()
        self.assertFalse(body["push_ready"])
        self.assertTrue(body["reason"])
        self.assertEqual((body["devices"], body["users"], body["recipients"]), (0, 0, 0))
        self.assertIsNone(body["last_push"])

    def test_ready_with_the_seeded_keys(self):
        self.seed_keys()
        body = self.status().json()
        self.assertTrue(body["push_ready"])
        self.assertIsNone(body["reason"])

    def test_unreadable_key_is_not_ready(self):
        self.seed_keys()
        helpers.put(self.db, "notifications.vapid_private_key", "not a key")
        body = self.status().json()
        self.assertFalse(body["push_ready"])
        self.assertTrue(body["reason"])

    def test_empty_key_is_not_ready(self):
        self.seed_keys()
        helpers.put(self.db, "notifications.vapid_public_key", "")
        body = self.status().json()
        self.assertFalse(body["push_ready"])
        self.assertTrue(body["reason"])

    def test_empty_admin_email_is_still_ready(self):
        # Push falls back to a valid contact when the Admin email is empty.
        self.seed_keys()
        helpers.put(self.db, "system.admin_email", "  ")
        body = self.status().json()
        self.assertTrue(body["push_ready"])
        self.assertIsNone(body["reason"])

    def test_admin_email_push_cannot_sign_with_is_not_ready(self):
        # "x@bad!.com" passes the Settings email pattern, but push services
        # need a contact py_vapid accepts: every push would be refused.
        self.seed_keys()
        helpers.put(self.db, "system.admin_email", "x@bad!.com")
        body = self.status().json()
        self.assertFalse(body["push_ready"])
        self.assertIn("Admin email", body["reason"])

    def test_counts_devices_people_and_last_push(self):
        from app.services import push
        self.add_sub("a@example.com", 1)
        self.add_sub("a@example.com", 2)
        self.add_sub("b@example.com", 1)
        last = {"at": "2026-09-22T10:00:00Z", "category": "test", "attempted": 2, "succeeded": 2}
        with mock.patch.object(push, "read_last_push", mock.AsyncMock(return_value=last)):
            body = self.status().json()
        self.assertEqual((body["devices"], body["users"], body["recipients"]), (3, 2, 2))
        self.assertEqual(body["last_push"], last)

    def test_people_are_counted_case_blind(self):
        # R84(a): one person whose devices were stored under two spellings.
        self.add_sub("A@example.com", 1)
        self.add_sub("a@example.com", 2)
        self.add_sub("b@example.com", 1)
        body = self.status().json()
        self.assertEqual((body["devices"], body["users"], body["recipients"]), (3, 2, 2))

    def test_recipients_are_the_broadcast_audience(self):
        # Push subscribers plus anyone notified in the last 30 days, once each.
        self.add_sub("a@example.com", 1)
        self.add_notification("A@example.com", 1)     # same person, already counted
        self.add_notification("c@example.com", 2)     # no device, still reached in-app
        self.add_notification("old@example.com", 40)  # outside the window
        self.add_notification("", 1)                  # no identity, never reached
        body = self.status().json()
        self.assertEqual((body["devices"], body["users"], body["recipients"]), (1, 1, 2))
        from app.routers import admin as admin_router
        self.assertEqual(admin_router._broadcast_recipients(self.db), {"a@example.com", "c@example.com"})

    def test_response_carries_only_the_status_keys(self):
        # R84(e): counts only; no emails, no endpoints.
        self.seed_keys()
        self.add_sub("a@example.com", 1)
        self.add_notification("c@example.com", 1)
        self.store["webservarr:push:last"] = (
            '{"at": "2026-09-22T10:00:00Z", "category": "news", "attempted": 1, "succeeded": 1}')
        r = self.status()
        self.assertEqual(set(r.json()), self.STATUS_KEYS)
        self.assertEqual(r.json()["last_push"]["category"], "news")
        for leak in ("example.com", "push.example", "PRIVATE KEY"):
            self.assertNotIn(leak, r.text)

    def test_members_are_refused(self):
        member = helpers.api_client(self.Session, helpers.MEMBER)
        self.assertEqual(member.get("/api/admin/notifications/status").status_code, 403)

    # --- recording the last push ----------------------------------------

    def test_dispatch_records_the_last_push(self):
        import asyncio
        from app.services import push
        asyncio.run(push._record_last_push("news", {"attempted": 3, "succeeded": 2}))
        asyncio.run(push._record_last_push("news", {"attempted": 0, "succeeded": 0}))   # not a real push
        got = asyncio.run(push.read_last_push())
        self.assertEqual((got["category"], got["attempted"], got["succeeded"]), ("news", 3, 2))
        self.assertRegex(got["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_nothing_recorded_reads_as_none(self):
        import asyncio
        from app.services import push
        self.assertIsNone(asyncio.run(push.read_last_push()))

    def test_a_real_dispatch_records_what_it_tried(self):
        import json
        import pywebpush
        self.seed_keys()
        self.add_sub("a@example.com", 1)
        self.add_sub("a@example.com", 2)
        self.add_sub("b@example.com", 1)
        calls = []

        def webpush(**kw):
            calls.append(kw)
            if kw["subscription_info"]["endpoint"].endswith("/2"):
                raise pywebpush.WebPushException("rejected")

        result = self._dispatch(["A@example.com"], "news", webpush)
        self.assertEqual(result, {"attempted": 2, "succeeded": 1})
        got = json.loads(self.store["webservarr:push:last"])
        self.assertEqual((got["category"], got["attempted"], got["succeeded"]), ("news", 2, 1))
        # R84(d): an admin test push is a push like any other.
        self._dispatch(["b@example.com"], "test")
        got = json.loads(self.store["webservarr:push:last"])
        self.assertEqual((got["category"], got["attempted"], got["succeeded"]), ("test", 1, 1))

    def test_a_dispatch_cut_off_by_the_budget_still_records(self):
        # A different way out of the fan-out: a send abandoned at the
        # wall-clock budget. It was attempted, so the push is recorded.
        import json
        import time
        from app.services import push
        self.seed_keys()
        self.add_sub("a@example.com", 1)
        self.add_sub("a@example.com", 2)

        def webpush(**kw):
            if kw["subscription_info"]["endpoint"].endswith("/2"):
                time.sleep(1.0)
                raise AssertionError("should have been abandoned")

        with mock.patch.object(push, "PUSH_TOTAL_BUDGET", 0.3):
            result = self._dispatch(["a@example.com"], "news", webpush)
        self.assertEqual(result, {"attempted": 2, "succeeded": 1})
        got = json.loads(self.store["webservarr:push:last"])
        self.assertEqual((got["attempted"], got["succeeded"]), (2, 1))

    def test_early_returns_record_nothing(self):
        import asyncio
        import sys
        from app.services import push
        self.add_sub("a@example.com", 1)
        # No VAPID keys.
        self.assertEqual(self._dispatch(["a@example.com"]), {"attempted": 0, "succeeded": 0})
        self.assertNotIn("webservarr:push:last", self.store)
        self.seed_keys()
        # Nobody asked for has a device.
        self.assertEqual(self._dispatch(["nobody@example.com"]), {"attempted": 0, "succeeded": 0})
        # Nobody asked for has an identity.
        self.assertEqual(self._dispatch(["", "none"]), {"attempted": 0, "succeeded": 0})
        # Push support missing: a device matched but nothing could be sent.
        with mock.patch.object(push, "SessionLocal", self.Session), \
             mock.patch.object(push, "is_safe_push_endpoint", return_value=True), \
             mock.patch.dict(sys.modules, {"pywebpush": None}):
            result = asyncio.run(push.dispatch_push(["a@example.com"], "Title", "Body", "news", "/"))
        self.assertEqual(result, {"attempted": 0, "succeeded": 0})
        self.assertNotIn("webservarr:push:last", self.store)
        # The same device with push support present is recorded, so the
        # checks above were not passing for some other reason.
        self._dispatch(["a@example.com"])
        self.assertIn("webservarr:push:last", self.store)

    def test_a_failed_record_never_breaks_sending(self):
        self.seed_keys()
        self.add_sub("a@example.com", 1)
        with mock.patch("app.auth.session_manager.get_redis",
                        mock.AsyncMock(side_effect=ConnectionError("redis down"))):
            self.assertEqual(self._dispatch(["a@example.com"]), {"attempted": 1, "succeeded": 1})


class PushStatusFixRound1(PushStatusBase):
    """Fix round 1: last_push shape, bounded Redis calls, no-identity devices,
    the send cutoff, the unreadable-key reason and the status rate limit."""

    VALID = {"at": "2026-09-22T10:00:00Z", "category": "news", "attempted": 2, "succeeded": 1}

    def read(self):
        import asyncio
        from app.services import push
        return asyncio.run(push.read_last_push())

    # 1. read_last_push only passes the G4 shape through.

    def test_read_rejects_anything_but_the_last_push_shape(self):
        import json
        bad = {
            "list": [1, 2],
            "int": 5,
            "string": "news",
            "partial": {"at": "2026-09-22T10:00:00Z", "category": "news"},
            "at not str": dict(self.VALID, at=1),
            "category not str": dict(self.VALID, category=None),
            "attempted str": dict(self.VALID, attempted="2"),
            "attempted bool": dict(self.VALID, attempted=True),
            "succeeded bool": dict(self.VALID, succeeded=False),
            "succeeded float": dict(self.VALID, succeeded=1.0),
        }
        for name, value in bad.items():
            with self.subTest(name):
                self.store["webservarr:push:last"] = json.dumps(value)
                self.assertIsNone(self.read())
        self.store["webservarr:push:last"] = "not json"
        self.assertIsNone(self.read())
        self.store["webservarr:push:last"] = json.dumps(self.VALID)
        self.assertEqual(self.read(), self.VALID)

    def test_read_keeps_only_the_four_fields(self):
        import json
        self.store["webservarr:push:last"] = json.dumps(dict(self.VALID, email="a@example.com"))
        self.assertEqual(self.read(), self.VALID)

    def test_endpoint_reports_a_malformed_record_as_none(self):
        self.store["webservarr:push:last"] = "[1, 2]"
        self.assertIsNone(self.status().json()["last_push"])

    # 2. A slow Redis never holds up a dispatch or the status read.

    def _slow_redis(self, seconds):
        import asyncio

        class SlowRedis:
            async def set(self, key, value, **kw):
                await asyncio.sleep(seconds)

            async def get(self, key):
                await asyncio.sleep(seconds)
                return b"{}"

        return mock.patch("app.auth.session_manager.get_redis", mock.AsyncMock(return_value=SlowRedis()))

    def test_slow_redis_does_not_hold_up_a_dispatch(self):
        import time
        self.seed_keys()
        self.add_sub("a@example.com", 1)
        with self._slow_redis(3.0):
            t0 = time.monotonic()
            result = self._dispatch(["a@example.com"])
            elapsed = time.monotonic() - t0
        self.assertEqual(result, {"attempted": 1, "succeeded": 1})
        self.assertLess(elapsed, 2.0)

    def test_slow_redis_read_gives_up_as_none(self):
        import time
        with self._slow_redis(3.0):
            t0 = time.monotonic()
            got = self.read()
            elapsed = time.monotonic() - t0
        self.assertIsNone(got)
        self.assertLess(elapsed, 2.0)

    # 3. Subscriptions under no identity are not devices or people.

    def test_no_identity_subscriptions_are_not_counted(self):
        self.add_sub("a@example.com", 1)
        self.add_sub("", 1)
        self.add_sub("none", 1)
        self.add_sub(" None ", 2)
        body = self.status().json()
        self.assertEqual((body["devices"], body["users"], body["recipients"]), (1, 1, 1))

    # 4. The broadcast keeps the 30-day cutoff.

    def test_send_skips_a_recipient_last_notified_over_30_days_ago(self):
        from app.models import Notification
        self.add_sub("fresh@example.com", 1)
        self.add_notification("stale@example.com", 31)
        sent = mock.AsyncMock(return_value=0)
        with mock.patch("app.routers.admin.send_push_to_users", sent):
            r = self.client.post("/api/admin/notifications/send", json={"title": "Hi", "body": "All"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["sent_to"], 1)
        self.assertEqual(sent.await_args.args[0], ["fresh@example.com"])
        self.db.expire_all()
        got = sorted(n.user_email for n in self.db.query(Notification).filter(Notification.title == "Hi"))
        self.assertEqual(got, ["fresh@example.com"])

    # 5. The unreadable-key reason is the fixed sentence, never the error.

    def test_unreadable_key_reason_is_static(self):
        from app.services import push
        self.seed_keys()
        with mock.patch.object(push, "load_vapid_key",
                               side_effect=ValueError("ASN.1 boom zq7-secret-detail")):
            body = self.status().json()
        self.assertFalse(body["push_ready"])
        self.assertEqual(body["reason"], "The push key couldn't be read.")
        for fragment in ("ASN.1", "boom", "zq7-secret-detail", "ValueError"):
            self.assertNotIn(fragment, body["reason"])

    # 6. Rate limited to 60 a minute, counted in a private store.

    def test_status_is_rate_limited_to_sixty_a_minute(self):
        from limits.storage import MemoryStorage
        from limits.strategies import FixedWindowRateLimiter
        from app.limiter import limiter
        saved = (limiter._storage, limiter._limiter)
        storage = MemoryStorage()
        limiter._storage, limiter._limiter = storage, FixedWindowRateLimiter(storage)
        try:
            limiter.reset()
            helpers.set_rate_limits(True)
            codes = [self.client.get("/api/admin/notifications/status").status_code for _ in range(61)]
            self.assertEqual(codes[:60], [200] * 60)
            self.assertEqual(codes[60], 429)
        finally:
            limiter.reset()
            limiter._storage, limiter._limiter = saved


if __name__ == "__main__":
    unittest.main()
