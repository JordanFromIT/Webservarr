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
import unittest

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

    def test_unset_is_the_default(self):
        payload = build_branding({}, {}, None, dict(EMPTY_WIKI_HOOKS))
        self.assertEqual(payload["logo_url"], self.DEFAULT)

    def test_inline_data_block_carries_the_safe_value(self):
        block = pages.data_block(_payload("/\\evil.example/x.ico"), None, "1.0.0", "index")
        data = json.loads(block.split(">", 1)[1].rsplit("<", 1)[0])
        self.assertEqual(data["branding"]["logo_url"], "")
        self.assertNotIn("evil.example", block)


if __name__ == "__main__":
    unittest.main()
