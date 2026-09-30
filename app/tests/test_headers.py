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

    def test_csp_media_src_is_self_and_plex_direct_only(self):
        # The audiobook player streams from the listener's Plex server over
        # its plex.direct https addresses, on any port (a server's remote
        # port is whatever its operator mapped). That is the only thing the
        # player adds: covers are served same-origin, so img-src is
        # unchanged, and no other directive names plex.direct.
        from app.config import settings
        r = self.client.get("/static/css/theme.css?v=1")
        directives = {}
        for d in r.headers["content-security-policy"].split(";"):
            name, _, value = d.strip().partition(" ")
            self.assertNotIn(name, directives, f"{name} appears twice")
            directives[name] = value
        self.assertEqual(directives["media-src"], "'self' https://*.plex.direct:*")
        expected = {
            "default-src": "'self'",
            "script-src": "'self'",
            "style-src": "'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src": "'self' https://fonts.gstatic.com",
            "img-src": "'self' data: https:",
            "worker-src": "'self'",
            "media-src": "'self' https://*.plex.direct:*",
            "frame-ancestors": "'self'",
            "base-uri": "'self'",
            "object-src": "'none'",
        }
        configured = {"frame-src", "connect-src"}
        self.assertEqual(set(directives) - configured, set(expected))
        for name, value in expected.items():
            self.assertEqual(directives[name], value, name)
        # connect-src and frame-src come only from the operator's config.
        connect = ["'self'"] + ([settings.authentik_url] if settings.authentik_url else []) + [
            s.strip() for s in settings.csp_connect_src.split(",") if s.strip()]
        self.assertEqual(directives["connect-src"], " ".join(connect))
        frames = [s.strip() for s in settings.csp_frame_src.split(",") if s.strip()]
        self.assertEqual(directives.get("frame-src", ""), " ".join(frames))


if __name__ == "__main__":
    unittest.main()
