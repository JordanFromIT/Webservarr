"""
Theme T2: every page uses the theme engine, so an operator's theme (a light
one included) reads correctly site-wide.

Run inside the container:
    python -m unittest discover -s /app/app/tests -t /app -v
"""
import re
import unittest
from unittest import mock

from app.tests.test_shell_contract import STATIC

try:
    from fastapi.testclient import TestClient
    from app.main import app
    from app import pages
    from app.routers.branding import EMPTY_WIKI_HOOKS, build_branding
    from app.tests.test_page_gating import ADMIN_SESSION, PageRoutesBase
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False
    PageRoutesBase = unittest.TestCase
    ADMIN_SESSION = {}

REQUESTS = (STATIC / "requests.html").read_text(encoding="utf-8")
ISSUES = (STATIC / "issues.html").read_text(encoding="utf-8")


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


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class RequestStatusNeverMovesThePage(PageRoutesBase):
    """O2: Request Status was shown at first paint and hidden once its data
    said nothing was waiting, which pulled the rest of the page up. The
    server now collapses it from the first paint when the cached snapshot,
    the same one the section's API returns, has nothing to show."""

    def html_tag(self, snapshot):
        with mock.patch("app.services.request_status.get_cached_snapshot",
                        mock.AsyncMock(return_value=snapshot)):
            r = self.get("/requests", ADMIN_SESSION)
        self.assertEqual(r.status_code, 200)
        return re.search(r"<html\b[^>]*>", r.text).group(0)

    def test_collapsed_when_nothing_is_waiting_or_it_is_unavailable(self):
        self.assertIn(" data-rs-empty", self.html_tag({"items": [], "total": 0}))
        self.assertIn(" data-rs-empty", self.html_tag({"error": "unavailable", "items": []}))

    def test_left_to_the_page_when_rows_exist_or_the_cache_is_cold(self):
        self.assertNotIn("data-rs-empty", self.html_tag({"items": [{"id": 1}], "total": 1}))
        self.assertNotIn("data-rs-empty", self.html_tag(None))


class RequestStatusCollapseMarkup(unittest.TestCase):
    def test_the_mark_hides_the_section_and_rows_lift_it(self):
        head = REQUESTS.split("</head>", 1)[0]
        self.assertIn("html[data-rs-empty] #rsSection { display: none; }", head)
        load = re.search(r"async function load\(user\) \{(.*?)\n  \}\n", REQUESTS, re.S).group(1)
        rows = load.index("if (!_rows.length)")
        self.assertGreater(load.index("document.documentElement.removeAttribute('data-rs-empty');"), rows)


class PageStylesAreInTheHead(unittest.TestCase):
    """Item 13: a page's own <style> sits in <head>, before the custom CSS
    the server writes last, so the operator's CSS wins at equal specificity."""

    def test_no_style_block_in_the_body(self):
        for name, text in (("requests", REQUESTS), ("issues", ISSUES)):
            head, body = text.split("</head>", 1)
            self.assertIn("<style>", head, name)
            self.assertNotIn("<style", body, name)


if __name__ == "__main__":
    unittest.main()
