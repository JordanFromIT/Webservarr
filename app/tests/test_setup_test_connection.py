"""
The setup wizard's Plex test, before any account exists.

There is no session during first-run setup, so the wizard cannot use the
admin-only POST /api/admin/test-connection. It uses POST
/api/setup/test-connection instead, gated by the same first-run setup token
that completes setup, and closed (403) once setup is done. It runs the
status-light probe, so the token travels in a header and no redirect is
followed. Before setup the admin route stays behind the /setup redirect.
"""
import unittest
from unittest import mock

try:
    from app.services import integration_health as health
    from app.tests import helpers
    from app.tests.test_integration_health import _Resp, _private_limiter, fake_factory
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False

SETUP_TOKEN = "first-run-token-4c1d"
PLEX_TOKEN = "PLEXTOKEN-setup-77aa"
BODY = {"setup_token": SETUP_TOKEN, "service": "plex",
        "url": "http://192.168.1.2:32400", "credentials": PLEX_TOKEN}


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SetupTestConnection(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.completed = False
        self.patches = [
            mock.patch("app.routers.setup.is_setup_completed", side_effect=lambda: self.completed),
            mock.patch("app.routers.setup.get_or_create_setup_token",
                       side_effect=lambda: "" if self.completed else SETUP_TOKEN),
        ]
        for p in self.patches:
            p.start()
        # Signed out: nobody has an account before setup.
        from fastapi import HTTPException
        from app.dependencies import get_current_user
        from app.main import app
        self.client = helpers.api_client(self.Session)

        def signed_out():
            raise HTTPException(status_code=401, detail="Not authenticated")
        app.dependency_overrides[get_current_user] = signed_out

    def tearDown(self):
        helpers.reset_overrides()
        for p in self.patches:
            p.stop()

    def post(self, body, calls, routes=None):
        routes = {"status/sessions": _Resp(200, {})} if routes is None else routes
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory(routes, calls)):
            return self.client.post("/api/setup/test-connection", json=body)

    def test_a_valid_token_probes_plex_before_setup(self):
        calls = []
        r = self.post(BODY, calls)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"success": True, "message": "Connected", "state": "ok"})
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0]["url"].endswith("/status/sessions"))
        self.assertEqual(calls[0]["headers"]["X-Plex-Token"], PLEX_TOKEN)
        self.assertNotIn(PLEX_TOKEN, calls[0]["url"])
        self.assertEqual(calls[0]["params"], {})

    def test_a_failure_carries_the_reason(self):
        calls = []
        r = self.post(BODY, calls, {"status/sessions": _Resp(401)})
        self.assertEqual(r.json(), {"success": False, "message": "It rejected the token", "state": "warn"})

    def test_an_unsafe_address_is_refused_without_a_request(self):
        calls = []
        r = self.post(dict(BODY, url="http://127.0.0.1:32400"), calls)
        self.assertEqual(r.json()["state"], "error")
        self.assertEqual(calls, [])

    def test_a_bad_or_missing_token_is_403(self):
        for body in (dict(BODY, setup_token="wrong"), dict(BODY, setup_token=""),
                     {k: v for k, v in BODY.items() if k != "setup_token"}):
            with self.subTest(token=body.get("setup_token")):
                calls = []
                r = self.post(body, calls)
                self.assertEqual(r.status_code, 403, r.text)
                self.assertIsInstance(r.json()["detail"], str)
                self.assertEqual(calls, [])

    def test_closed_once_setup_is_done(self):
        self.completed = True
        calls = []
        r = self.post(BODY, calls)
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(calls, [])

    def test_closed_once_setup_is_done_even_if_the_token_still_matched(self):
        # The completion check comes first, as in complete_setup: it doesn't
        # rely on the token getter having emptied.
        self.completed = True
        calls = []
        with mock.patch("app.routers.setup.get_or_create_setup_token", return_value=SETUP_TOKEN):
            r = self.post(BODY, calls)
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(r.json(), {"detail": "Setup has already been completed."})
        self.assertEqual(calls, [])

    def test_plex_only(self):
        calls = []
        r = self.post(dict(BODY, service="sonarr"), calls)
        self.assertEqual(r.status_code, 422, r.text)
        self.assertEqual(calls, [])

    def test_the_admin_route_is_behind_the_setup_redirect(self):
        calls = []
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory({}, calls)):
            r = self.client.post("/api/admin/test-connection", follow_redirects=False,
                                 json={"service": "plex", "url": "http://192.168.1.2:32400",
                                       "credentials": PLEX_TOKEN})
        self.assertEqual(r.status_code, 302, r.text)
        self.assertEqual(r.headers["location"], "/setup")
        self.assertEqual(calls, [])

    def test_rate_limited_to_ten_a_minute(self):
        restore = _private_limiter()
        try:
            helpers.set_rate_limits(True)
            calls = []
            codes = [self.post(BODY, calls).status_code for _ in range(11)]
            self.assertEqual(codes[:10], [200] * 10)
            self.assertEqual(codes[10], 429)
        finally:
            restore()


if __name__ == "__main__":
    unittest.main()
