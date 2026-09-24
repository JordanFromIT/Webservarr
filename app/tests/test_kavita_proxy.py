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


class _FakeResponse:
    def __init__(self, payload):
        self.status_code = 200
        self._payload = payload

    def json(self):
        return self._payload


class _FakeKavita:
    """Stands in for httpx.AsyncClient: the callback, the account, the JWT."""
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def request(self, *args, **kwargs):
        return _FakeResponse({})

    async def get(self, *args, **kwargs):
        return _FakeResponse({"apiKey": "key"})

    async def post(self, *args, **kwargs):
        return _FakeResponse({"token": "jwt"})


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class HandshakeLandsOnEbooks(unittest.TestCase):
    """The Kavita sign-in finishes on the eBooks page itself (/ebooks), not on
    the old /library address, which would cost a second redirect."""

    def setUp(self):
        from fastapi.testclient import TestClient
        from app.config import settings
        from app.main import app
        from app.tests import helpers
        self.helpers = helpers
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        helpers.set_rate_limits(False)
        self.client = TestClient(app)
        self.client.cookies.set(settings.session_cookie_name, "test-session")

    def tearDown(self):
        self.setup_patch.stop()
        self.helpers.set_rate_limits(True)

    def finish(self, kavita_cookies):
        sm = kavita_proxy.session_manager
        with mock.patch.object(sm, "get_session", mock.AsyncMock(return_value={"username": "sam"})), \
             mock.patch.object(sm, "update_session", mock.AsyncMock()), \
             mock.patch.object(kavita_proxy, "get_kavita_url", return_value=KAVITA), \
             mock.patch.object(kavita_proxy, "collect_cookies", return_value=kavita_cookies), \
             mock.patch.object(kavita_proxy.httpx, "AsyncClient", _FakeKavita):
            return self.client.post("/signin-oidc", data={"code": "c"}, follow_redirects=False)

    def test_success_lands_on_ebooks(self):
        r = self.finish(".AspNetCore.Cookies=abc")
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/ebooks"))

    def test_failure_lands_on_ebooks_with_the_error_flag(self):
        r = self.finish("")
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/ebooks?kavita=error"))


if __name__ == "__main__":
    unittest.main()
