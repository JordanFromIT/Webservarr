"""
branding.logo_url is sanitised where the payload is built.

The value goes into /api/branding and each page's inline #ws-data block, and
theme-loader.js puts it in the favicon on every page (login.html uses it for
the public login logo). An admin-entered "/\\evil.example/x.ico" would make
every visitor's browser fetch from another host, so build_branding (the one
builder for both) only lets http(s) or a same-origin path through; anything
else becomes "" (no logo), which the shell already turns into its icon.
"""
import json
import os
import unittest
from unittest import mock

try:
    from app import pages
    from app.routers.branding import DEFAULTS, EMPTY_WIKI_HOOKS, build_branding
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False


def _payload(logo):
    return build_branding({"branding.logo_url": logo}, {}, None, dict(EMPTY_WIKI_HOOKS))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class LogoUrlTests(unittest.TestCase):
    DEFAULT = None

    def setUp(self):
        self.DEFAULT = DEFAULTS["branding.logo_url"]

    def test_malicious_values_become_no_logo(self):
        for bad in ("/\\evil.example/x.ico", "/\t/evil.example/x.ico", "//evil.example/x.ico",
                    "javascript:alert(1)", "data:image/svg+xml,<svg/>"):
            with self.subTest(bad=bad):
                self.assertEqual(_payload(bad)["logo_url"], "")

    def test_good_values_pass(self):
        self.assertEqual(_payload("/static/uploads/logo-1.png")["logo_url"], "/static/uploads/logo-1.png")
        self.assertEqual(_payload("https://cdn.example.com/l.png")["logo_url"], "https://cdn.example.com/l.png")
        self.assertEqual(_payload("")["logo_url"], "")

    def test_malformed_absolute_urls_become_no_logo(self):
        for bad in ("http://[::1", "https://[", "http://", "https://:80/x",
                    "https://cdn.example.com:99999/x", "https://good.example\\@evil.example/x"):
            with self.subTest(bad=bad):
                self.assertEqual(_payload(bad)["logo_url"], "")

    def test_scheme_is_case_insensitive(self):
        self.assertEqual(_payload("HTTPS://cdn.example.com/l.png")["logo_url"], "HTTPS://cdn.example.com/l.png")
        self.assertEqual(_payload("Http://cdn.example.com/l.png")["logo_url"], "Http://cdn.example.com/l.png")

    def test_unset_is_the_default(self):
        payload = build_branding({}, {}, None, dict(EMPTY_WIKI_HOOKS))
        self.assertEqual(payload["logo_url"], self.DEFAULT)

    def test_inline_data_block_carries_the_safe_value(self):
        block = pages.data_block(_payload("/\\evil.example/x.ico"), None, "1.0.0", "index")
        data = json.loads(block.split(">", 1)[1].rsplit("<", 1)[0])
        self.assertEqual(data["branding"]["logo_url"], "")
        self.assertNotIn("evil.example", block)



try:
    from fastapi.testclient import TestClient

    from app.database import get_db
    from app.dependencies import get_current_user
    from app.limiter import limiter
    from app.main import app
    from app.models import Setting
    from app.tests.test_push import make_session_factory
    HAVE_CLIENT = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_CLIENT = False


@unittest.skipUnless(HAVE_CLIENT, "app import needs the container's dependencies")
class LogoWriteValidationTests(unittest.TestCase):
    """A logo URL the payload would blank is refused when it is saved.

    Otherwise the settings form (filled from the public, sanitised value)
    would save the blank back and silently erase the stored logo.
    """

    def setUp(self):
        self.Session = make_session_factory()

        def _db():
            db = self.Session()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[get_current_user] = lambda: {"email": "admin@example.com", "is_admin": "true"}
        self._limiter_was = limiter.enabled
        limiter.enabled = False
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()
        limiter.enabled = self._limiter_was

    def _stored(self, key):
        db = self.Session()
        try:
            row = db.query(Setting).filter(Setting.key == key).first()
            return row.value if row else None
        finally:
            db.close()

    def test_bad_logo_urls_are_refused(self):
        for bad in ("//cdn.example.com/x.png", "static/x.png", "/\\evil.example/x.png",
                    "javascript:alert(1)", "http://[::1", "https://[", "http://",
                    "https://:80/x"):
            with self.subTest(bad=bad):
                r = self.client.put("/api/admin/settings",
                                    json={"key": "branding.logo_url", "value": bad})
                self.assertEqual(r.status_code, 400, r.text)
                self.assertIn("logo URL", r.json()["detail"])
                self.assertIsNone(self._stored("branding.logo_url"))

    def test_good_logo_urls_are_saved(self):
        for good in ("/static/uploads/logo-1.png", "HTTPS://cdn.example.com/l.png", ""):
            with self.subTest(good=good):
                r = self.client.put("/api/admin/settings",
                                    json={"key": "branding.logo_url", "value": good})
                self.assertEqual(r.status_code, 200, r.text)
                self.assertEqual(self._stored("branding.logo_url"), good)

    def test_bulk_save_with_a_bad_logo_writes_nothing(self):
        r = self.client.put("/api/admin/settings/bulk", json={"settings": [
            {"key": "branding.app_name", "value": "Changed"},
            {"key": "branding.logo_url", "value": "static/x.png"},
        ]})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIsNone(self._stored("branding.app_name"))
        self.assertIsNone(self._stored("branding.logo_url"))



@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class RenderNeverFallsBackToRawTests(unittest.TestCase):
    """No stored logo value may make render_page serve the raw file.

    render_page catches any rendering error and serves the unrendered page
    (no sidebar, header, theme or #ws-data) - site-wide, for as long as the
    bad value is stored. "http://[::1" once did exactly that.
    """

    STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")

    def test_index_renders_for_any_stored_logo(self):
        user = {"username": "root", "is_admin": "true", "auth_method": "simple"}
        for stored in ("http://[::1", "https://[", "http://", "https://:80/x",
                       "/\\evil.example/x.png", "/icons.svg#logo", "javascript:x", ""):
            with self.subTest(stored=stored):
                ctx = (_payload(stored), {"netdata": False})
                with mock.patch.object(pages, "STATIC_DIR", self.STATIC), \
                     mock.patch.object(pages, "load_context", return_value=ctx), \
                     self.assertNoLogs(pages.logger, level="WARNING"):
                    resp = pages.render_page("index", None, user)
                body = resp.body.decode()
                self.assertNotIn("<!-- ws:sidebar -->", body)
                self.assertNotIn("<!-- ws:header -->", body)
                self.assertIn('id="desktopSidebar"', body)
                self.assertIn('id="ws-data"', body)

    def test_preview_meta_survives_an_unparseable_logo(self):
        name, meta = pages._preview_meta({"logo_url": "http://[::1"}, "https://example.test", "/")
        self.assertNotIn("og:image", meta)


if __name__ == "__main__":
    unittest.main()
