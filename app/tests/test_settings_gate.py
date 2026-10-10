"""
Only an admin gets Settings, enforced by the server on every way in, not by
hiding links.

Each check goes through the real sign-in path: the session cookie is looked up
in the session store (patched here to know one admin and one member session),
so get_current_user and require_admin run as they do live. Three callers: no
cookie, a member's cookie, the admin's cookie.

The ways in:
- the page, /settings, as a full load and as the router's soft navigation
  (the same route, with X-WS-Nav: 1); /settings/next only redirects to it;
- the page's raw file, /static/settings.html (never served, test_page_gating);
- every /api/admin route: the settings reads and writes (registry view,
  export, import, bulk save, the shell fragment), the account, connection
  tests, logo upload, notifications, integrations health and Chaptarr
  options, the Books pairing tools and the tickets list. The sweep reads them
  from the app's OpenAPI document, so a route added there later without
  require_admin fails here;
- the first-run setup wizard, which writes settings without a session and is
  closed once setup is done.

What stays public is read-only: /api/branding (the theme and branding the
shell paints with, theme.frost_* included) and the web manifest, both built
from the registry's public keys only, so no secret reaches them.
"""
import re
import unittest
from unittest import mock

try:
    import httpx
    from fastapi.testclient import TestClient

    from app import main, pages
    from app.auth import session_manager
    from app.config import settings
    from app.database import get_db
    from app.main import app
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

ADMIN_SID = "test-admin-session"
MEMBER_SID = "test-member-session"
WRITES = {"post", "put", "patch", "delete"}
ADMIN_REQUIRED = "Admin access required"
# The settings endpoints the Settings page itself calls; the sweep must find each.
SETTINGS_API = [
    ("get", "/api/admin/settings"), ("get", "/api/admin/settings/export"),
    ("get", "/api/admin/settings/shell"), ("put", "/api/admin/settings/bulk"),
    ("post", "/api/admin/settings/import"), ("put", "/api/admin/account"),
    ("post", "/api/admin/test-connection"), ("post", "/api/admin/upload-logo"),
    ("get", "/api/admin/notifications/status"), ("post", "/api/admin/notifications/send"),
    ("post", "/api/admin/notifications/test-push"), ("get", "/api/admin/integrations/health"),
    ("get", "/api/admin/chaptarr/options"), ("get", "/api/admin/books/status"),
]
SECRET = "plex-token-never-public"


def _concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "1", path)


def _admin_operations():
    for path, item in app.openapi()["paths"].items():
        if path.startswith("/api/admin/"):
            for method in item:
                if method in WRITES or method == "get":
                    yield method, path


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SettingsGateBase(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.addCleanup(self.db.close)
        helpers.put(self.db, "integration.plex.token", SECRET)
        helpers.put(self.db, "theme.frost_blur", "15")

        def _db():
            db = self.Session()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = _db
        self.addCleanup(app.dependency_overrides.pop, get_db, None)
        helpers.set_rate_limits(False)
        self.addCleanup(helpers.set_rate_limits, True)

        sessions = {ADMIN_SID: dict(helpers.ADMIN), MEMBER_SID: dict(helpers.MEMBER)}

        async def get_session(session_id):
            return sessions.get(session_id)

        # Nothing here may reach a real service or the dev instance's data:
        # page renders read the in-memory database, every outbound call fails.
        offline = httpx.ConnectError("offline in tests")
        for patch in (mock.patch.object(session_manager, "get_session", side_effect=get_session),
                      mock.patch("app.routers.setup.is_setup_completed", return_value=True),
                      mock.patch.object(pages, "SessionLocal", self.Session),
                      mock.patch.object(main, "SessionLocal", self.Session),
                      mock.patch.object(httpx.AsyncClient, "send", side_effect=offline)):
            patch.start()
            self.addCleanup(patch.stop)

    def client(self, sid=None):
        c = TestClient(app, headers=helpers.SAME_ORIGIN, follow_redirects=False)
        if sid:
            c.cookies.set(settings.session_cookie_name, sid)
        return c

    def callers(self):
        return {"signed out": self.client(), "member": self.client(MEMBER_SID), "admin": self.client(ADMIN_SID)}


class SettingsPage(SettingsGateBase):
    def test_only_the_admin_gets_the_page(self):
        for headers in ({}, {"X-WS-Nav": "1"}):
            c = self.callers()
            with self.subTest(soft_nav=bool(headers)):
                r = c["signed out"].get("/settings", headers=headers)
                self.assertEqual((r.status_code, r.headers.get("location")), (302, "/login"))
                r = c["member"].get("/settings", headers=headers)
                self.assertEqual((r.status_code, r.headers.get("location")), (302, "/"))
                r = c["admin"].get("/settings", headers=headers)
                self.assertEqual(r.status_code, 200)
                self.assertIn('id="ws-data"', r.text)

    def test_the_old_preview_address_only_redirects(self):
        for name, c in self.callers().items():
            with self.subTest(caller=name):
                r = c.get("/settings/next")
                self.assertEqual((r.status_code, r.headers.get("location")), (301, "/settings"))

    def test_the_raw_page_file_is_never_served(self):
        for name, c in self.callers().items():
            with self.subTest(caller=name):
                self.assertEqual(c.get("/static/settings.html").status_code, 404)


class AdminApi(SettingsGateBase):
    def send(self, client, method, path):
        return client.request(method, _concrete(path), json={})

    def test_the_sweep_finds_the_settings_endpoints(self):
        found = set(_admin_operations())
        for op in SETTINGS_API:
            self.assertIn(op, found)

    def test_signed_out_gets_401_everywhere(self):
        c = self.client()
        for method, path in _admin_operations():
            with self.subTest(method=method, path=path):
                self.assertEqual(self.send(c, method, path).status_code, 401)

    def test_a_member_gets_403_everywhere(self):
        c = self.client(MEMBER_SID)
        for method, path in _admin_operations():
            with self.subTest(method=method, path=path):
                r = self.send(c, method, path)
                self.assertEqual(r.status_code, 403, r.text)
                self.assertEqual(r.json().get("detail"), ADMIN_REQUIRED)

    def test_the_admin_reads_the_settings(self):
        c = self.client(ADMIN_SID)
        for path in ("/api/admin/settings", "/api/admin/settings?view=registry",
                     "/api/admin/settings/export", "/api/admin/settings/shell"):
            with self.subTest(path=path):
                r = c.get(path)
                self.assertEqual(r.status_code, 200, r.text)
                self.assertNotIn(SECRET, r.text)

    def save_frost(self, client, value):
        return client.put("/api/admin/settings/bulk",
                          json={"settings": [{"key": "theme.frost_blur", "value": value}]})

    def test_only_the_admin_saves_a_setting(self):
        for name in ("signed out", "member"):
            with self.subTest(caller=name):
                r = self.save_frost(self.callers()[name], "40")
                self.assertIn(r.status_code, (401, 403))
                self.assertEqual(helpers.get(self.db, "theme.frost_blur"), "15")
        r = self.save_frost(self.client(ADMIN_SID), "40")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(helpers.get(self.db, "theme.frost_blur"), "40")

    def test_a_member_cannot_import_settings(self):
        r = self.client(MEMBER_SID).post("/api/admin/settings/import?dry_run=false",
                                         json={"data": {"settings": {"theme.frost_blur": "40"}}})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(helpers.get(self.db, "theme.frost_blur"), "15")


class PublicReads(SettingsGateBase):
    def test_branding_is_public_and_holds_no_secret(self):
        for name, c in self.callers().items():
            with self.subTest(caller=name):
                r = c.get("/api/branding")
                self.assertEqual(r.status_code, 200)
                self.assertEqual(r.json()["frost_blur"], 15)
                self.assertNotIn(SECRET, r.text)

    def test_branding_has_no_write(self):
        c = self.client(ADMIN_SID)
        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                self.assertEqual(c.request(method, "/api/branding", json={}).status_code, 405)

    def test_manifest_holds_no_secret(self):
        r = self.client().get("/manifest.webmanifest")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(SECRET, r.text)


class SetupWizard(SettingsGateBase):
    """The wizard writes settings with no session, so it must be shut once setup is done."""

    def test_closed_after_setup(self):
        body = {"username": "x", "password": "xxxxxxxx", "password_confirm": "xxxxxxxx",
                "plex_url": "http://evil.example", "plex_token": "t"}
        for name, c in self.callers().items():
            with self.subTest(caller=name):
                r = c.get("/setup")
                self.assertEqual((r.status_code, r.headers.get("location")), (302, "/login"))
                self.assertEqual(c.post("/api/setup/complete", json=body).status_code, 403)
                self.assertEqual(c.post("/api/setup/test-connection", json={"url": "http://x"}).status_code, 403)
        self.assertEqual(helpers.get(self.db, "integration.plex.url"), None)


if __name__ == "__main__":
    unittest.main()
