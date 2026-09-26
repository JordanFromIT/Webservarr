"""
A saved secret only ever goes to the address it was saved with.

An integration's token or API key is sent to its address on every status
check and poll. So moving the address to a different host must not quietly
take the saved secret along:

* BulkSave (the Settings page) refuses a new address (422 on the address)
  unless the same save enters the secret again, or clears it. The same
  address written differently (a trailing slash, the host's case) is not new.
* Import never carries secrets, so a file that moves an address clears that
  integration's saved secret, and the preview lists the clearing (the
  diff token covers it).

Without this, a shared settings file that changes only integration.seerr.url
sends the stored Seerr key to the file author's host on the next check.
"""
import asyncio
import unittest
from unittest import mock

try:
    from app import settings_registry as reg
    from app.routers.admin_settings import LOCKOUT_MESSAGE, effective_values
    from app.services import integration_health as health
    from app.tests import helpers
    from app.tests.test_integration_health import _Resp, fake_factory
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False

SEERR_URL = "http://192.168.1.5:5055"
SEERR_KEY = "SYNTH-SEERR-KEY-71c2"
SONARR_URL = "http://192.168.1.6:8989"
SONARR_KEY = "SYNTH-SONARR-KEY-0b9e"
ELSEWHERE = "http://10.66.6.6:5055"      # the file author's host (a literal address: no DNS)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class AddressBase(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        self.client = helpers.api_client(self.Session)
        for k, v in (("integration.seerr.url", SEERR_URL), ("integration.seerr.api_key", SEERR_KEY),
                     ("integration.sonarr.url", SONARR_URL), ("integration.sonarr.api_key", SONARR_KEY)):
            helpers.put(self.db, k, v)

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()
        self.db.close()

    def save(self, *pairs):
        return self.client.put("/api/admin/settings/bulk",
                               json={"settings": [{"key": k, "value": v} for k, v in pairs]})

    def importing(self, settings, dry=True, token=None):
        data = {"format": "webservarr-settings", "format_version": 1, "settings": settings}
        return self.client.post("/api/admin/settings/import?dry_run=" + ("true" if dry else "false"),
                                json={"data": data, "diff_token": token})

    def outbound_after_a_check(self):
        """Every request the status check sends for the saved settings."""
        calls = []
        self.db.expire_all()
        values = effective_values(self.db)
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory({"": _Resp(200, {})}, calls)):
            asyncio.run(health.check_all(values))
        return calls


class BulkSaveNewAddress(AddressBase):
    def test_a_new_host_without_the_key_is_refused_on_the_address(self):
        r = self.save(("integration.seerr.url", ELSEWHERE))
        self.assertEqual(r.status_code, 422, r.text)
        self.assertEqual(r.json()["errors"], {"integration.seerr.url": "Enter the key again for the new address"})
        self.assertEqual(helpers.get(self.db, "integration.seerr.url"), SEERR_URL)
        self.assertEqual(helpers.get(self.db, "integration.seerr.api_key"), SEERR_KEY)

    def test_the_key_sent_back_masked_does_not_count(self):
        r = self.save(("integration.seerr.url", ELSEWHERE), ("integration.seerr.api_key", reg.MASK))
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn("integration.seerr.url", r.json()["errors"])
        self.assertEqual(helpers.get(self.db, "integration.seerr.url"), SEERR_URL)

    def test_plex_asks_for_the_token(self):
        helpers.put(self.db, "integration.plex.url", "http://192.168.1.9:32400")
        helpers.put(self.db, "integration.plex.token", "SYNTH-PLEX-TOKEN")
        r = self.save(("integration.plex.url", "http://10.66.6.6:32400"))
        self.assertEqual(r.status_code, 422, r.text)
        self.assertEqual(r.json()["errors"]["integration.plex.url"], "Enter the token again for the new address")

    def test_authentik_asks_for_the_client_secret(self):
        helpers.put(self.db, "integration.authentik.url", "https://auth.example.com")
        helpers.put(self.db, "integration.authentik.client_secret", "SYNTH-CLIENT-SECRET")
        r = self.save(("integration.authentik.url", "https://auth.example.net"))
        self.assertEqual(r.status_code, 422, r.text)
        self.assertEqual(r.json()["errors"]["integration.authentik.url"],
                         "Enter the client secret again for the new address")

    def test_a_new_host_with_the_key_entered_again_saves(self):
        r = self.save(("integration.seerr.url", ELSEWHERE), ("integration.seerr.api_key", "SYNTH-NEW-KEY"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(helpers.get(self.db, "integration.seerr.url"), ELSEWHERE)
        self.assertEqual(helpers.get(self.db, "integration.seerr.api_key"), "SYNTH-NEW-KEY")

    def test_a_new_host_with_the_key_cleared_saves(self):
        r = self.save(("integration.seerr.url", ELSEWHERE), ("integration.seerr.api_key", ""))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(helpers.get(self.db, "integration.seerr.api_key"), "")

    def test_the_same_address_written_differently_saves(self):
        for same in (SEERR_URL + "/", "HTTP://192.168.1.5:5055", "HTTP://192.168.1.5:5055/"):
            r = self.save(("integration.seerr.url", same))
            self.assertEqual(r.status_code, 200, (same, r.text))
            self.assertEqual(helpers.get(self.db, "integration.seerr.api_key"), SEERR_KEY)

    def test_clearing_the_address_saves(self):
        r = self.save(("integration.seerr.url", ""))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(helpers.get(self.db, "integration.seerr.url"), "")

    def test_an_address_after_a_clear_still_needs_the_key(self):
        # Clearing first and then typing a new host must not get round the rule.
        self.assertEqual(self.save(("integration.seerr.url", "")).status_code, 200)
        r = self.save(("integration.seerr.url", ELSEWHERE))
        self.assertEqual(r.status_code, 422, r.text)

    def test_no_saved_key_no_rule(self):
        helpers.put(self.db, "integration.radarr.url", "http://192.168.1.7:7878")
        r = self.save(("integration.radarr.url", "http://192.168.1.8:7878"))
        self.assertEqual(r.status_code, 200, r.text)

    def test_nyt_has_no_address_and_is_unaffected(self):
        helpers.put(self.db, "integration.nyt.api_key", "SYNTH-NYT")
        r = self.save(("integration.nyt.api_key", reg.MASK), ("branding.app_name", "Cinema"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(helpers.get(self.db, "integration.nyt.api_key"), "SYNTH-NYT")


class ImportNewAddress(AddressBase):
    def test_the_preview_lists_the_key_clearing(self):
        r = self.importing({"integration.sonarr.url": ELSEWHERE})
        self.assertEqual(r.status_code, 200, r.text)
        changes = r.json()["changes"]
        self.assertEqual(changes, [
            {"key": "integration.sonarr.api_key", "old": reg.MASK, "new": "",
             "note": "Sonarr API key will be cleared (its address changed)"},
            {"key": "integration.sonarr.url", "old": SONARR_URL, "new": ELSEWHERE},
        ])
        self.assertNotIn(SONARR_KEY, r.text)
        # A preview writes nothing.
        self.assertEqual(helpers.get(self.db, "integration.sonarr.api_key"), SONARR_KEY)

    def test_apply_clears_the_key(self):
        preview = self.importing({"integration.sonarr.url": ELSEWHERE}).json()
        r = self.importing({"integration.sonarr.url": ELSEWHERE}, dry=False, token=preview["diff_token"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(sorted(r.json()["applied"]), ["integration.sonarr.api_key", "integration.sonarr.url"])
        self.assertEqual(helpers.get(self.db, "integration.sonarr.url"), ELSEWHERE)
        self.assertEqual(helpers.get(self.db, "integration.sonarr.api_key"), "")
        # The other integration keeps its key.
        self.assertEqual(helpers.get(self.db, "integration.seerr.api_key"), SEERR_KEY)

    def test_the_diff_token_covers_the_clearing(self):
        # Previewed with no key saved (nothing to clear); a key saved since
        # would now be cleared, which the admin never saw: refused.
        helpers.put(self.db, "integration.sonarr.api_key", "")
        preview = self.importing({"integration.sonarr.url": ELSEWHERE}).json()
        self.assertEqual([c["key"] for c in preview["changes"]], ["integration.sonarr.url"])
        helpers.put(self.db, "integration.sonarr.api_key", SONARR_KEY)
        r = self.importing({"integration.sonarr.url": ELSEWHERE}, dry=False, token=preview["diff_token"])
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual(helpers.get(self.db, "integration.sonarr.api_key"), SONARR_KEY)
        self.assertEqual(helpers.get(self.db, "integration.sonarr.url"), SONARR_URL)

    def test_the_same_address_written_differently_keeps_the_key(self):
        preview = self.importing({"integration.sonarr.url": SONARR_URL + "/"}).json()
        self.assertEqual([c["key"] for c in preview["changes"]], ["integration.sonarr.url"])
        r = self.importing({"integration.sonarr.url": SONARR_URL + "/"}, dry=False, token=preview["diff_token"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(helpers.get(self.db, "integration.sonarr.api_key"), SONARR_KEY)

    def test_a_secret_in_the_file_is_still_ignored(self):
        # The file can't supply the key for its new address either.
        r = self.importing({"integration.sonarr.url": ELSEWHERE, "integration.sonarr.api_key": "SYNTH-FROM-FILE"})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertIn("integration.sonarr.api_key", body["ignored"])
        cleared = [c for c in body["changes"] if c["key"] == "integration.sonarr.api_key"]
        self.assertEqual(cleared[0]["new"], "")
        self.assertNotIn("SYNTH-FROM-FILE", r.text)

    def test_a_plex_move_that_would_lock_everyone_out_is_refused(self):
        # Clearing the token turns Plex sign-in off; with nothing else on, the
        # import is refused by the lockout guard like any other change.
        for k, v in (("features.show_simple_auth", "false"), ("features.show_plex_auth", "true"),
                     ("integration.plex.url", "http://192.168.1.9:32400"),
                     ("integration.plex.token", "SYNTH-PLEX-TOKEN")):
            helpers.put(self.db, k, v)
        r = self.importing({"integration.plex.url": "http://10.66.6.6:32400"})
        self.assertEqual(r.status_code, 422, r.text)
        self.assertEqual(r.json()["detail"], LOCKOUT_MESSAGE)
        self.assertEqual(helpers.get(self.db, "integration.plex.token"), "SYNTH-PLEX-TOKEN")


class ExfiltrationScenario(AddressBase):
    """The audit's M2 scenario, end to end: a file that changes only the Seerr
    address is imported, then the status lights are checked. No request may
    carry the saved Seerr key."""

    def carrying(self, calls, secret):
        return [c for c in calls if secret in repr(c)]

    def test_the_saved_key_is_sent_before_the_import(self):
        # The check does send the key to the saved address: the scenario's
        # detector works.
        calls = self.outbound_after_a_check()
        self.assertTrue([c for c in self.carrying(calls, SEERR_KEY) if c["url"].startswith(SEERR_URL)])

    def test_an_imported_address_never_receives_the_saved_key(self):
        file_settings = {"integration.seerr.url": ELSEWHERE, "theme.color_primary": "#123456"}
        preview = self.importing(file_settings)
        self.assertEqual(preview.status_code, 200, preview.text)
        r = self.importing(file_settings, dry=False, token=preview.json()["diff_token"])
        self.assertEqual(r.status_code, 200, r.text)
        calls = self.outbound_after_a_check()
        self.assertEqual(self.carrying(calls, SEERR_KEY), [])
        self.assertEqual([c for c in calls if c["url"].startswith(ELSEWHERE)], [])

    def test_a_saved_address_change_never_sends_the_saved_key(self):
        r = self.save(("integration.seerr.url", ELSEWHERE), ("integration.seerr.api_key", reg.MASK))
        self.assertEqual(r.status_code, 422, r.text)
        calls = self.outbound_after_a_check()
        self.assertEqual([c for c in self.carrying(calls, SEERR_KEY) if not c["url"].startswith(SEERR_URL)], [])


if __name__ == "__main__":
    unittest.main()
