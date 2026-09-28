"""
Response headers on static assets.

Versioned assets are immutable (their ?v= marker is a content hash), the
service worker must never be cached long and must be allowed to control the
whole origin. Runs against the real app with the test client; page routes are
not exercised here because they need Redis.
"""
import unittest

try:
    from fastapi.testclient import TestClient
    from app.main import app
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class StaticHeaders(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_versioned_assets_are_immutable(self):
        r = self.client.get("/static/css/theme.css?v=1.0.0-abcd1234")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["cache-control"], "public, max-age=31536000, immutable")

    def test_unversioned_assets_are_short_lived(self):
        r = self.client.get("/static/css/theme.css")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["cache-control"], "public, max-age=300")

    def test_service_worker_scope_and_cache(self):
        r = self.client.get("/static/sw.js")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["service-worker-allowed"], "/")
        self.assertEqual(r.headers["cache-control"], "no-cache")

    def test_security_headers_still_present(self):
        r = self.client.get("/static/css/theme.css?v=1")
        self.assertEqual(r.headers["x-content-type-options"], "nosniff")
        self.assertNotIn("cdn.tailwindcss.com", r.headers["content-security-policy"])

    def test_csp_script_src_is_self_only(self):
        # Soft navigation's end state (spec 7): no page carries an inline
        # script or handler, so script-src is exactly 'self'. No
        # 'unsafe-inline', no 'unsafe-eval', no nonce, no other host.
        r = self.client.get("/static/css/theme.css?v=1")
        directives = [d.strip() for d in r.headers["content-security-policy"].split(";")]
        script = [d for d in directives if d.split(" ", 1)[0] == "script-src"]
        self.assertEqual(script, ["script-src 'self'"])


if __name__ == "__main__":
    unittest.main()
