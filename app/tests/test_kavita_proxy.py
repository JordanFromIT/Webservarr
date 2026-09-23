"""
The Kavita handshake redirect allow-list resolves Authentik like the OIDC client.

/kavita/connect relays Kavita's redirect to the Authentik authorize endpoint and
refuses any other origin (open-redirect guard). Installs configure Authentik in
the settings table, not the AUTHENTIK_URL env var, so an allow-list built from
the env var alone refused every legitimate redirect. These tests pin DB-first,
env-fallback resolution and that foreign origins stay refused.
"""
import unittest
from unittest import mock

try:
    from app.routers import kavita_proxy
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False


KAVITA = "http://kavita.invalid:5000"
AUTHORIZE = "https://auth.example.com/application/o/authorize/?client_id=x&state=y"


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class LocationAllowed(unittest.TestCase):
    def _allowed(self, location, db_url="", env_url=""):
        rows = {"integration.authentik.url": db_url}
        with mock.patch.object(kavita_proxy, "_read_setting",
                               side_effect=lambda key: rows.get(key, "")), \
             mock.patch.object(kavita_proxy.settings, "authentik_url", env_url):
            return kavita_proxy._location_allowed(location, KAVITA)

    def test_db_url_allows_authorize_endpoint(self):
        self.assertTrue(self._allowed(AUTHORIZE, db_url="https://auth.example.com"))

    def test_db_url_with_trailing_slash_allows_authorize_endpoint(self):
        self.assertTrue(self._allowed(AUTHORIZE, db_url="https://auth.example.com/"))

    def test_env_fallback_allows_authorize_endpoint(self):
        self.assertTrue(self._allowed(AUTHORIZE, env_url="https://auth.example.com"))

    def test_db_url_takes_precedence_over_env(self):
        self.assertTrue(self._allowed(AUTHORIZE, db_url="https://auth.example.com",
                                      env_url="https://old-auth.example.com"))
        self.assertFalse(self._allowed("https://old-auth.example.com/authorize",
                                       db_url="https://auth.example.com",
                                       env_url="https://old-auth.example.com"))

    def test_foreign_origin_rejected(self):
        self.assertFalse(self._allowed("https://evil.example/authorize",
                                       db_url="https://auth.example.com"))
        self.assertFalse(self._allowed("https://evil.example/authorize",
                                       env_url="https://auth.example.com"))

    def test_same_host_other_scheme_or_port_rejected(self):
        self.assertFalse(self._allowed("http://auth.example.com/authorize",
                                       db_url="https://auth.example.com"))
        self.assertFalse(self._allowed("https://auth.example.com:8443/authorize",
                                       db_url="https://auth.example.com"))

    def test_nothing_configured_allows_only_kavita_itself(self):
        self.assertTrue(self._allowed(KAVITA + "/login"))
        self.assertFalse(self._allowed(AUTHORIZE))
        self.assertFalse(self._allowed("https://evil.example/"))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class GetAuthentikUrl(unittest.TestCase):
    def test_reads_the_settings_row(self):
        with mock.patch.object(kavita_proxy, "_read_setting",
                               return_value="https://auth.example.com/"), \
             mock.patch.object(kavita_proxy.settings, "authentik_url", ""):
            self.assertEqual(kavita_proxy.get_authentik_url(), "https://auth.example.com/")

    def test_falls_back_to_env_when_row_empty(self):
        with mock.patch.object(kavita_proxy, "_read_setting", return_value=""), \
             mock.patch.object(kavita_proxy.settings, "authentik_url",
                               "https://auth.example.com"):
            self.assertEqual(kavita_proxy.get_authentik_url(), "https://auth.example.com")


if __name__ == "__main__":
    unittest.main()
