"""
Theme T2: every page uses the theme engine, so an operator's theme (a light
one included) reads correctly site-wide.

Run inside the container:
    python -m unittest discover -s /app/app/tests -t /app -v
"""
import unittest
from unittest import mock

try:
    from fastapi.testclient import TestClient
    from app.main import app
    from app import pages
    from app.routers.branding import EMPTY_WIKI_HOOKS, build_branding
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class PlexPopupPageIsThemed(unittest.TestCase):
    """L9: the page the Plex popup lands on was bare HTML (black on white).
    It now carries the operator's colours, font and custom CSS like every
    other page, and still hands the sign-in back to the opener."""

    def fetch(self, values):
        b = build_branding(values, {}, None, dict(EMPTY_WIKI_HOOKS))
        with mock.patch.object(pages, "load_context", return_value=(b, {"netdata": False})) as ctx:
            r = TestClient(app).get("/auth/plex-callback-page")
        ctx.assert_called_once_with(False)   # public branding only
        return r

    def test_it_wears_the_operators_theme(self):
        r = self.fetch({"theme.color_background": "#F8FAFC", "theme.color_text": "#0F172A",
                        "theme.custom_css": "p { letter-spacing: 1px; }"})
        self.assertEqual(r.status_code, 200)
        body = r.text
        self.assertIn('<style id="ws-theme">:root{', body)
        self.assertIn("--color-background:248 250 252", body)
        self.assertIn("--color-text:15 23 42", body)
        self.assertIn('<script id="ws-data" type="application/json">', body)
        self.assertIn('<script src="/static/js/theme-loader.js"></script>', body)
        self.assertIn('<link href="/static/css/theme.css" rel="stylesheet">', body)
        self.assertIn("background: rgb(var(--color-background))", body)
        self.assertIn("color: rgb(var(--color-text) / .7)", body)
        head = body.split("</head>", 1)[0]
        self.assertTrue(head.rstrip().endswith("p { letter-spacing: 1px; }</style>"),
                        "the custom CSS is the last thing in <head>")
        self.assertLess(head.index("theme.css"), head.index('id="webservarr-custom-css"'))

    def test_generic_copy_and_the_handoff_still_work(self):
        body = self.fetch({}).text
        self.assertIn("Signing you in", body)
        self.assertNotIn("Plex Auth", body)
        self.assertIn("window.opener.postMessage({type: 'plex-auth-complete'}, ", body)
        self.assertIn("window.location.href = '/login?plex_auth=complete';", body)
        self.assertNotIn("webservarr-custom-css", body)   # none saved, none written


if __name__ == "__main__":
    unittest.main()
