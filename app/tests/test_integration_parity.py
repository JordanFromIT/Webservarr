"""
The status light and Test read each integration setting the way the real
client does, so a light is only green when the client would work too.

Two ways they drifted apart: the probe trimmed every value while the clients
sent the stored one as is (a key pasted with a trailing space tested green,
and httpx refuses to send that header), and the probe tested an empty Uptime
Kuma slug as "default" while the client called the empty slug.
"""
import asyncio
import importlib
import unittest
from contextlib import ExitStack
from unittest import mock

try:
    import h11
    from app.routers.admin_settings import effective_values
    from app.services import integration_health as health
    from app.settings_registry import get_def, validate_value
    from app.tests import helpers
    from app.tests.test_integration_health import KUMA_PAGE, _Resp, fake_factory
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False

CLIENT_MODULES = ("plex", "seerr", "sonarr", "radarr", "chaptarr", "uptime_kuma", "netdata", "nyt", "config")

# service -> (credential key, what the client's config calls it)
CREDENTIALS = {
    "plex": ("integration.plex.token", "token"),
    "seerr": ("integration.seerr.api_key", "api_key"),
    "sonarr": ("integration.sonarr.api_key", "api_key"),
    "radarr": ("integration.radarr.api_key", "api_key"),
    "chaptarr": ("integration.chaptarr.api_key", "api_key"),
    "netdata": ("integration.netdata.api_key", "api_key"),
}


def client_sessions(Session):
    """Point every integration client's DB reads at the test database."""
    stack = ExitStack()
    for name in CLIENT_MODULES:
        try:
            mod = importlib.import_module(f"app.integrations.{name}")
        except ImportError:
            continue
        if hasattr(mod, "SessionLocal"):
            stack.enter_context(mock.patch.object(mod, "SessionLocal", Session))
    return stack


def client_config(service):
    mod = importlib.import_module(f"app.integrations.{service}")
    return mod._get_config()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ProbeReadsLikeTheClient(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()

    def tearDown(self):
        self.db.close()

    def probe(self, service, routes=None):
        calls = []
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory(routes or {}, calls)):
            result = asyncio.run(health.probe_one(service, effective_values(self.db)))
        return result, calls

    def test_the_client_cannot_send_a_key_with_a_trailing_space(self):
        # What the real client hits: h11 (under httpx) refuses the header value.
        with self.assertRaises(h11.LocalProtocolError):
            h11.Request(method="GET", target="/", headers=[("Host", "x"), ("X-Api-Key", "abc ")])

    def test_a_stored_key_with_surrounding_space_is_not_green(self):
        for service, (key, field) in CREDENTIALS.items():
            for bad in ("abc ", " abc", "   "):
                with self.subTest(service=service, value=repr(bad)):
                    helpers.put(self.db, f"integration.{service}.url", "http://192.168.1.5:8000")
                    helpers.put(self.db, key, bad)
                    with client_sessions(self.Session):
                        self.assertEqual(client_config(service)[field], bad)   # what the client sends
                    result, calls = self.probe(service)
                    self.assertEqual(result["state"], "warn", result)
                    self.assertIn("space", result["reason"])
                    self.assertEqual(calls, [])

    def test_a_stored_nyt_key_with_surrounding_space_is_not_green(self):
        from app.integrations import nyt
        helpers.put(self.db, "integration.nyt.api_key", "n-key ")
        with client_sessions(self.Session):
            self.assertEqual(nyt._api_key(), "n-key ")
        result, calls = self.probe("nyt")
        self.assertEqual(result["state"], "warn", result)
        self.assertEqual(calls, [])

    def test_a_stored_address_with_a_leading_space_is_not_green(self):
        helpers.put(self.db, "integration.sonarr.url", " http://192.168.1.5:8989")
        helpers.put(self.db, "integration.sonarr.api_key", "s-key")
        with client_sessions(self.Session):
            self.assertEqual(client_config("sonarr")["url"], " http://192.168.1.5:8989")
        result, calls = self.probe("sonarr", {"system/status": _Resp(200, {})})
        self.assertNotEqual(result["state"], "ok", result)
        self.assertEqual(calls, [])

    def test_a_clean_key_is_still_tested_as_stored(self):
        helpers.put(self.db, "integration.sonarr.url", "http://192.168.1.5:8989/")
        helpers.put(self.db, "integration.sonarr.api_key", "s-key")
        with client_sessions(self.Session):
            cfg = client_config("sonarr")
        result, calls = self.probe("sonarr", {"system/status": _Resp(200, {})})
        self.assertEqual(result["state"], "ok")
        self.assertEqual(calls[0]["headers"]["X-Api-Key"], cfg["api_key"])
        self.assertEqual(calls[0]["url"], cfg["url"] + "/api/v3/system/status")

    def test_an_empty_slug_row_is_the_same_page_for_probe_and_client(self):
        helpers.put(self.db, "integration.uptime_kuma.url", "http://192.168.1.7:3001")
        helpers.put(self.db, "integration.uptime_kuma.slug", "")
        with client_sessions(self.Session):
            cfg = client_config("uptime_kuma")
        self.assertEqual(cfg["slug"], "default")
        result, calls = self.probe("uptime_kuma", {"heartbeat/": _Resp(200, KUMA_PAGE)})
        self.assertEqual(calls[0]["url"], f"{cfg['url']}/api/status-page/heartbeat/{cfg['slug']}")

    def test_no_slug_row_is_the_default_page_for_both(self):
        helpers.put(self.db, "integration.uptime_kuma.url", "http://192.168.1.7:3001")
        with client_sessions(self.Session):
            self.assertEqual(client_config("uptime_kuma")["slug"], "default")
        _result, calls = self.probe("uptime_kuma", {"heartbeat/": _Resp(200, KUMA_PAGE)})
        self.assertTrue(calls[0]["url"].endswith("/heartbeat/default"))

    def test_a_chaptarr_folder_is_compared_as_the_client_sends_it(self):
        # The client sends the stored folder as is; "/books " is not "/books".
        values = {"integration.chaptarr.root_folder": "/books "}
        state, reason = health.map_response("chaptarr", 200, [{"path": "/books"}], values)
        self.assertEqual(state, "warn")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SavingRefusesWhatTheClientCannotUse(unittest.TestCase):
    def test_a_secret_with_surrounding_space_is_refused(self):
        for key in ("integration.plex.token", "integration.sonarr.api_key", "integration.nyt.api_key",
                    "integration.netdata.api_key", "integration.authentik.client_secret"):
            for bad in ("abc ", " abc", "abc\n", "   "):
                with self.subTest(key=key, value=repr(bad)):
                    self.assertIsNotNone(validate_value(key, bad))
            self.assertIsNone(validate_value(key, "abc"))
            self.assertIsNone(validate_value(key, ""))

    def test_an_empty_slug_is_refused_so_clear_restores_the_default(self):
        self.assertIsNotNone(validate_value("integration.uptime_kuma.slug", ""))
        d = get_def("integration.uptime_kuma.slug")
        self.assertFalse(d.allow_empty)
        self.assertEqual(d.default, "default")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TestButtonReadsLikeTheClient(unittest.TestCase):
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

    def test_a_typed_key_with_a_trailing_space_is_not_green(self):
        calls = []
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory({"system/status": _Resp(200, {})}, calls)):
            r = self.client.post("/api/admin/test-connection", json={
                "service": "sonarr", "url": "http://192.168.1.5:8989", "credentials": "abc "})
        self.assertEqual(r.json()["state"], "warn", r.text)
        self.assertIn("space", r.json()["message"])
        self.assertEqual(calls, [])

    def test_a_typed_address_with_a_space_is_not_green(self):
        calls = []
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory({"system/status": _Resp(200, {})}, calls)):
            r = self.client.post("/api/admin/test-connection", json={
                "service": "sonarr", "url": "http://192.168.1.5:8989 ", "credentials": "abc"})
        self.assertNotEqual(r.json()["state"], "ok", r.text)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
