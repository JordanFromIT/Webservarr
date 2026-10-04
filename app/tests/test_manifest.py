"""
The home-screen app (docs/superpowers/specs/2026-10-04-mobile-nav-and-home-screen-design.md,
Part 2): GET /manifest.webmanifest, built from the branding settings, and the
branding.app_icon_url setting ("Home-screen icon") with its bundled default.
"""
import json
import os
import struct
import unittest

try:
    from app import pages
    from app.routers.branding import DEFAULTS, EMPTY_WIKI_HOOKS, build_branding
    from app.seed import DEFAULT_SETTINGS
    from app.settings_registry import REGISTRY, validate_value
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")
DEFAULT_ICON = "/static/webservarr-app-512.png"


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    assert head[:8] == b"\x89PNG\r\n\x1a\n", path
    return struct.unpack(">II", head[16:24])


def payload(**values):
    return build_branding(values, {}, None, dict(EMPTY_WIKI_HOOKS))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class AppIconSetting(unittest.TestCase):
    def test_default_lives_in_both_tables(self):
        self.assertEqual(REGISTRY["branding.app_icon_url"].default, DEFAULT_ICON)
        self.assertEqual(DEFAULTS["branding.app_icon_url"], DEFAULT_ICON)
        self.assertEqual(DEFAULT_SETTINGS["branding.app_icon_url"][0], DEFAULT_ICON)
        self.assertTrue(REGISTRY["branding.app_icon_url"].public)

    def test_bundled_icons_are_square_pngs_at_192_and_512(self):
        self.assertEqual(png_size(os.path.join(STATIC, "webservarr-app-192.png")), (192, 192))
        self.assertEqual(png_size(os.path.join(STATIC, "webservarr-app-512.png")), (512, 512))

    def test_validation_matches_the_logo(self):
        for ok in ("/static/uploads/logo-1a2b3c4d.png", "https://cdn.example.com/icon.png", ""):
            self.assertIsNone(validate_value("branding.app_icon_url", ok), ok)
        for bad in ("//evil.example/i.png", "/\\evil.example/i.png", "javascript:alert(1)", "ftp://x/i.png"):
            self.assertIsNotNone(validate_value("branding.app_icon_url", bad), bad)

    def test_payload_carries_a_safe_icon(self):
        self.assertEqual(payload()["app_icon_url"], DEFAULT_ICON)
        self.assertEqual(payload(**{"branding.app_icon_url": "/static/uploads/i.png"})["app_icon_url"],
                         "/static/uploads/i.png")
        for bad in ("//evil.example/i.png", "javascript:alert(1)"):
            self.assertEqual(payload(**{"branding.app_icon_url": bad})["app_icon_url"], "")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ManifestBuilder(unittest.TestCase):
    def setUp(self):
        pages.STATIC_DIR = STATIC

    def test_defaults(self):
        m = pages.web_manifest(payload())
        self.assertEqual(m["name"], "WebServarr")
        self.assertEqual(m["short_name"], "WebServarr")
        self.assertEqual(m["start_url"], "/")
        self.assertEqual(m["scope"], "/")
        self.assertEqual(m["id"], "/")
        self.assertEqual(m["display"], "standalone")
        self.assertEqual(m["theme_color"], "#000000")
        self.assertEqual(m["background_color"], "#000000")
        self.assertEqual(m["description"], "Media Server Management")
        self.assertEqual(m["icons"], [
            {"src": "/static/webservarr-app-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/static/webservarr-app-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "/static/webservarr-app-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ])

    def test_reflects_branding(self):
        m = pages.web_manifest(payload(**{"branding.app_name": "  Family Films ", "theme.color_background": "#101820",
                                          "branding.tagline": ""}))
        self.assertEqual((m["name"], m["short_name"]), ("Family Films", "Family Films"))
        self.assertEqual((m["theme_color"], m["background_color"]), ("#101820", "#101820"))
        self.assertNotIn("description", m)
        # No name: the tagline, then the shipped name, so the app is never unnamed.
        self.assertEqual(pages.web_manifest(payload(**{"branding.app_name": "", "branding.tagline": "Films"}))["name"],
                         "Films")
        self.assertEqual(pages.web_manifest(payload(**{"branding.app_name": "", "branding.tagline": ""}))["name"],
                         "WebServarr")

    def test_a_custom_icon_declares_its_real_size(self):
        m = pages.web_manifest(payload(**{"branding.app_icon_url": "/static/webservarr-app-192.png"}))
        self.assertEqual(m["icons"], [{"src": "/static/webservarr-app-192.png", "sizes": "192x192",
                                       "type": "image/png", "purpose": "any"}])
        # A web address can't be measured here: the size the setting asks for.
        m = pages.web_manifest(payload(**{"branding.app_icon_url": "https://cdn.example.test/i.png"}))
        self.assertEqual(m["icons"], [{"src": "https://cdn.example.test/i.png", "sizes": "512x512",
                                       "type": "image/png", "purpose": "any"}])
        # Empty or unsafe: the bundled pair.
        for v in ("", "//evil.example/i.png"):
            m = pages.web_manifest(payload(**{"branding.app_icon_url": v}))
            self.assertEqual([i["src"] for i in m["icons"]][:2],
                             ["/static/webservarr-app-192.png", "/static/webservarr-app-512.png"])
        # A local file that is not a readable PNG (gone, or outside /static): the bundled pair.
        for v in ("/static/uploads/missing.png", "/static/../../etc/passwd"):
            m = pages.web_manifest(payload(**{"branding.app_icon_url": v}))
            self.assertEqual(m["icons"][0]["src"], "/static/webservarr-app-192.png", v)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ManifestRoute(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        db = self.Session()
        helpers.put(db, "branding.app_name", "Test Site")
        helpers.put(db, "theme.color_background", "#112233")
        db.close()

    def tearDown(self):
        helpers.reset_overrides()

    def test_served_publicly_as_a_manifest(self):
        client = helpers.api_client(self.Session, user=None)
        r = client.get("/manifest.webmanifest")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.headers["content-type"].startswith("application/manifest+json"))
        self.assertEqual(r.headers["cache-control"], "no-cache")
        m = json.loads(r.text)
        self.assertEqual(m["name"], "Test Site")
        self.assertEqual(m["background_color"], "#112233")
        self.assertEqual(m["start_url"], "/")

    def test_not_held_by_the_setup_redirect(self):
        from app.main import setup_redirect_middleware  # noqa: F401 - the exempt list lives beside it
        src = open(os.path.join(os.path.dirname(STATIC), "main.py"), encoding="utf-8").read()
        self.assertRegex(src, r'setup_exempt = \([^)]*"/manifest\.webmanifest"')


if __name__ == "__main__":
    unittest.main()
