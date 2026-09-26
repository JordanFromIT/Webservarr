"""
Settings backup: export writes every non-secret setting; import previews the
exact diff, then applies exactly that diff. Secrets never travel either way.

Only keys whose value would change are validated. A value this install
already holds that today's rules reject (a legacy value) comes back as a
warning, so exporting and re-importing on the same install always works.
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
SAVE_FAILED = "Couldn't save the settings right now. Nothing was changed; please try again."


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SettingsBackup(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        self.client = helpers.api_client(self.Session)

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()
        self.db.close()

    def export(self):
        r = self.client.get("/api/admin/settings/export")
        self.assertEqual(r.status_code, 200, r.text)
        return r

    def post(self, data, dry=True, token=None):
        return self.client.post("/api/admin/settings/import?dry_run=" + ("true" if dry else "false"),
                                json={"data": data, "diff_token": token})

    def assertRejected(self, r):
        """422 with per-key errors and a string detail."""
        self.assertEqual(r.status_code, 422, r.text)
        body = r.json()
        self.assertIsInstance(body["detail"], str)
        self.assertIsInstance(body["errors"], dict)
        self.assertTrue(body["errors"])
        return body["errors"]

    def test_export_shape_and_secrets(self):
        helpers.put(self.db, "integration.plex.token", "secret-token")
        helpers.put(self.db, "branding.app_name", "Cinema")
        helpers.put(self.db, "monitor.4.enabled", "false")
        r = self.export()
        self.assertIn("attachment", r.headers["content-disposition"])
        self.assertIn("webservarr-settings-", r.headers["content-disposition"])
        self.assertEqual(r.headers["cache-control"], "no-store")
        self.assertNotIn("secret-token", r.text)
        body = r.json()
        self.assertEqual(body["format"], "webservarr-settings")
        self.assertEqual(body["format_version"], 1)
        self.assertTrue(body["exported_at"].endswith("Z"))
        self.assertEqual(body["settings"]["branding.app_name"], "Cinema")
        self.assertEqual(body["settings"]["branding.tagline"], "Media Server Management")
        self.assertEqual(body["settings"]["monitor.4.enabled"], "false")
        self.assertNotIn("integration.plex.token", body["settings"])
        self.assertNotIn("system.secret_key", body["settings"])
        self.assertIn("integration.plex.token", body["secrets_excluded"])
        self.assertNotIn("integration.seerr.api_key", body["secrets_excluded"])   # not set, nothing left out

    def test_export_never_contains_internal_rows(self):
        internal = {
            "system.secret_key": "internal-secret-key-value",
            "notifications.vapid_private_key": "internal-vapid-private-value",
            "notifications.vapid_public_key": "internal-vapid-public-value",
            "system.setup_token": "internal-setup-token-value",
            "setup.completed": "internal-setup-marker-value",
            "seed.default_news_v1": "internal-seed-marker-value",
            "migration.requests_rename_v1": "internal-migration-marker-value",
            USER_KEY: "internal-user-pref-value",
        }
        for key, value in internal.items():
            helpers.put(self.db, key, value)
        for d in reg.active_defs():
            if d.secret:
                helpers.put(self.db, d.key, "registry-secret-" + d.key)
        r = self.export()
        for key, value in internal.items():
            self.assertNotIn(key, r.text)
            self.assertNotIn(value, r.text)
        self.assertNotIn("registry-secret-", r.text)
        self.assertNotIn("notify.", r.text)
        body = r.json()
        for key in body["settings"]:
            d = reg.get_def(key)
            self.assertIsNotNone(d, key)
            self.assertFalse(d.secret, key)
        self.assertEqual(sorted(body["secrets_excluded"]),
                         sorted(d.key for d in reg.active_defs() if d.secret))

    def test_round_trip_changes_nothing(self):
        r = self.post(self.export().json())
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["changes"], [])
        self.assertEqual(r.json()["warnings"], {})

    def test_dry_run_diff_is_exactly_what_apply_writes(self):
        data = self.export().json()
        data["settings"]["branding.app_name"] = "Imported"
        data["settings"]["news.homepage_count"] = "7"
        dry = self.post(data)
        self.assertEqual(dry.status_code, 200, dry.text)
        self.assertEqual(dry.json()["changes"], [
            {"key": "branding.app_name", "old": "WebServarr", "new": "Imported"},
            {"key": "news.homepage_count", "old": "3", "new": "7"},
        ])
        self.assertIsNone(helpers.get(self.db, "branding.app_name"))    # a preview writes nothing
        applied = self.post(data, dry=False, token=dry.json()["diff_token"])
        self.assertEqual(applied.status_code, 200, applied.text)
        self.assertEqual(applied.json()["applied"], ["branding.app_name", "news.homepage_count"])
        self.assertEqual(helpers.get(self.db, "branding.app_name"), "Imported")
        self.assertEqual(helpers.get(self.db, "news.homepage_count"), "7")

    def test_secrets_in_a_file_are_ignored(self):
        helpers.put(self.db, "integration.plex.token", "real")
        data = self.export().json()
        data["settings"]["integration.plex.token"] = "evil"
        dry = self.post(data)
        self.assertIn("integration.plex.token", dry.json()["ignored"])
        self.assertEqual(dry.json()["changes"], [])
        self.post(data, dry=False, token=dry.json()["diff_token"])
        self.assertEqual(helpers.get(self.db, "integration.plex.token"), "real")

    def test_retired_rows_never_reach_the_export(self):
        # Rows for keys retired in v1.11 may remain in an old database.
        for key, value in (("features.show_tickets", "false"), ("icon.nav_requests_embed", "download"),
                           ("integration.uptime_kuma.api_key", "old-key")):
            helpers.put(self.db, key, value)
        r = self.export()
        body = r.json()
        for key in ("features.show_tickets", "icon.nav_requests_embed", "integration.uptime_kuma.api_key"):
            self.assertNotIn(key, body["settings"], key)
            self.assertNotIn(key, body["secrets_excluded"], key)
        self.assertNotIn("old-key", r.text)
        # So a file from this install imports back onto it unchanged.
        dry = self.post(body)
        self.assertEqual(dry.status_code, 200, dry.text)
        self.assertEqual(dry.json()["changes"], [])
        self.assertEqual(dry.json()["ignored"], [])

    def test_a_retired_key_in_a_file_is_an_unknown_setting(self):
        data = self.export().json()
        data["settings"]["branding.app_name"] = "Fine"
        data["settings"]["features.show_tickets"] = "false"
        data["settings"]["integration.uptime_kuma.api_key"] = "old-key"
        errors = self.assertRejected(self.post(data))
        self.assertEqual(errors, {"features.show_tickets": "Unknown setting",
                                  "integration.uptime_kuma.api_key": "Unknown setting"})
        self.assertRejected(self.post(data, dry=False, token="anything"))
        self.assertIsNone(helpers.get(self.db, "branding.app_name"))
        self.assertIsNone(helpers.get(self.db, "features.show_tickets"))

    def test_an_invalid_value_rejects_the_whole_file(self):
        data = self.export().json()
        data["settings"]["branding.app_name"] = "Fine"
        data["settings"]["theme.color_primary"] = "red"
        errors = self.assertRejected(self.post(data))
        self.assertIn("theme.color_primary", errors)
        errors = self.assertRejected(self.post(data, dry=False, token="anything"))
        self.assertIn("theme.color_primary", errors)
        self.assertIsNone(helpers.get(self.db, "branding.app_name"))

    def test_a_legacy_value_round_trips_with_a_warning(self):
        # Stored before today's rules: exporting and re-importing it changes
        # nothing, so it is a warning, not an error.
        helpers.put(self.db, "theme.color_primary", "red")
        data = self.export().json()
        self.assertEqual(data["settings"]["theme.color_primary"], "red")
        data["settings"]["branding.app_name"] = "Imported"
        dry = self.post(data)
        self.assertEqual(dry.status_code, 200, dry.text)
        self.assertEqual(dry.json()["changes"],
                         [{"key": "branding.app_name", "old": "WebServarr", "new": "Imported"}])
        self.assertEqual(list(dry.json()["warnings"]), ["theme.color_primary"])
        self.assertIsInstance(dry.json()["warnings"]["theme.color_primary"], str)
        applied = self.post(data, dry=False, token=dry.json()["diff_token"])
        self.assertEqual(applied.status_code, 200, applied.text)
        self.assertEqual(applied.json()["applied"], ["branding.app_name"])
        self.assertEqual(helpers.get(self.db, "theme.color_primary"), "red")

    def test_changing_a_legacy_value_to_another_invalid_one_is_an_error(self):
        helpers.put(self.db, "theme.color_primary", "red")
        data = self.export().json()
        data["settings"]["theme.color_primary"] = "blue"
        errors = self.assertRejected(self.post(data))
        self.assertIn("theme.color_primary", errors)
        self.assertEqual(helpers.get(self.db, "theme.color_primary"), "red")

    def test_per_user_rows_are_not_exported_and_are_refused_on_import(self):
        helpers.put(self.db, "push.user.0123456789abcdef.email", "sam@example.com")
        helpers.put(self.db, USER_KEY, "false")
        r = self.export()
        self.assertNotIn("sam@example.com", r.text)
        self.assertNotIn("push.user.", r.text)
        self.assertNotIn("notify.", r.text)
        data = r.json()
        data["settings"][USER_KEY] = "true"
        errors = self.assertRejected(self.post(data))
        self.assertEqual(errors[USER_KEY], reg.USER_DATA_MESSAGE)
        data = r.json()
        data["settings"]["push.user.0123456789abcdef.email"] = "evil@example.com"
        self.assertIn("push.user.0123456789abcdef.email", self.assertRejected(self.post(data)))
        self.assertEqual(helpers.get(self.db, "push.user.0123456789abcdef.email"), "sam@example.com")
        self.assertEqual(helpers.get(self.db, USER_KEY), "false")

    def test_internal_rows_in_a_file_are_refused(self):
        helpers.put(self.db, "system.secret_key", "real")
        data = self.export().json()
        data["settings"]["system.secret_key"] = "evil"
        self.assertIn("system.secret_key", self.assertRejected(self.post(data)))
        self.assertEqual(helpers.get(self.db, "system.secret_key"), "real")

    def test_unknown_key_and_wrong_file(self):
        data = self.export().json()
        data["settings"]["made.up"] = "x"
        self.assertIn("made.up", self.assertRejected(self.post(data)))
        errors = self.assertRejected(self.post({"hello": 1}))
        self.assertIn("_file", errors)
        data = self.export().json()
        data["format_version"] = 2
        self.assertIn("_file", self.assertRejected(self.post(data)))
        data = self.export().json()
        data["settings"]["branding.app_name"] = 5
        self.assertIn("branding.app_name", self.assertRejected(self.post(data)))

    def test_apply_refuses_a_stale_or_missing_preview(self):
        data = self.export().json()
        data["settings"]["branding.app_name"] = "Imported"
        token = self.post(data).json()["diff_token"]
        helpers.put(self.db, "branding.app_name", "Changed meanwhile")
        self.assertEqual(self.post(data, dry=False, token=token).status_code, 409)
        self.assertEqual(helpers.get(self.db, "branding.app_name"), "Changed meanwhile")
        self.assertEqual(self.post(data, dry=False, token=None).status_code, 409)

    def test_lockout_guard_applies_to_imports(self):
        data = self.export().json()
        data["settings"]["features.show_simple_auth"] = "false"
        errors = self.assertRejected(self.post(data))
        self.assertIn("features.show_simple_auth", errors)

    def test_lockout_guard_only_when_sign_in_keys_change(self):
        # An install already without a usable method (set outside Settings)
        # can still round-trip its file: the file changes no sign-in key.
        helpers.put(self.db, "features.show_simple_auth", "false")
        data = self.export().json()
        data["settings"]["branding.app_name"] = "Imported"
        dry = self.post(data)
        self.assertEqual(dry.status_code, 200, dry.text)
        self.assertEqual([c["key"] for c in dry.json()["changes"]], ["branding.app_name"])

    def test_a_write_failure_on_apply_saves_nothing_and_is_503(self):
        from sqlalchemy.orm import Session as SASession
        data = self.export().json()
        data["settings"]["branding.app_name"] = "Imported"
        data["settings"]["branding.tagline"] = "Also"
        token = self.post(data).json()["diff_token"]
        with mock.patch.object(SASession, "commit", autospec=True,
                               side_effect=RuntimeError("database is locked")):
            r = self.post(data, dry=False, token=token)
        self.assertEqual(r.status_code, 503, r.text)
        self.assertEqual(r.json()["detail"], SAVE_FAILED)
        self.assertIsNone(helpers.get(self.db, "branding.app_name"))
        self.assertIsNone(helpers.get(self.db, "branding.tagline"))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class OldBackupEmptySlug(unittest.TestCase):
    """An older install's page could save an empty Uptime Kuma slug, which the
    client reads as the default page. Settings now refuses an empty slug, so
    an import reads one in the file the same way: as "default"."""

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        self.client = helpers.api_client(self.Session)

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()
        self.db.close()

    def file(self, **settings):
        return {"format": "webservarr-settings", "format_version": 1, "app_version": "1.10.11",
                "exported_at": "2026-09-01T00:00:00Z", "settings": settings, "secrets_excluded": []}

    def preview(self, data):
        r = self.client.post("/api/admin/settings/import?dry_run=true", json={"data": data})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def apply(self, data):
        token = self.preview(data)["diff_token"]
        r = self.client.post("/api/admin/settings/import?dry_run=false", json={"data": data, "diff_token": token})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_empty_slug_onto_a_default_install_is_no_change(self):
        for empty in ("", "  "):
            with self.subTest(value=repr(empty)):
                body = self.preview(self.file(**{"integration.uptime_kuma.slug": empty}))
                self.assertEqual(body["changes"], [])

    def test_empty_slug_onto_a_custom_slug_becomes_default(self):
        helpers.put(self.db, "integration.uptime_kuma.slug", "family")
        data = self.file(**{"integration.uptime_kuma.slug": ""})
        self.assertEqual(self.preview(data)["changes"],
                         [{"key": "integration.uptime_kuma.slug", "old": "family", "new": "default"}])
        self.apply(data)
        self.assertEqual(helpers.get(self.db, "integration.uptime_kuma.slug"), "default")

    def test_other_changes_in_the_same_file_still_apply(self):
        data = self.file(**{"integration.uptime_kuma.slug": "", "branding.app_name": "Cinema"})
        body = self.apply(data)
        self.assertEqual(body["applied"], ["branding.app_name"])
        self.assertEqual(helpers.get(self.db, "branding.app_name"), "Cinema")


if __name__ == "__main__":
    unittest.main()


class ImportAdminEmailPushContact(SettingsBackup):
    """Polish A R127: an import can't bring in an Admin email push refuses;
    one already stored and unchanged by the file is only a warning."""

    def test_a_changed_bad_address_is_refused(self):
        data = self.export().json()
        data["settings"]["system.admin_email"] = "name@gmail..com"
        errors = self.assertRejected(self.post(data))
        self.assertIn("system.admin_email", errors)

    def test_an_unchanged_bad_row_is_a_warning(self):
        helpers.put(self.db, "system.admin_email", "name@gmail..com")
        data = self.export().json()
        self.assertEqual(data["settings"]["system.admin_email"], "name@gmail..com")
        r = self.post(data)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("system.admin_email", r.json()["warnings"])
