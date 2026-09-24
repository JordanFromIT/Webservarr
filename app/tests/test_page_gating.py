"""
Off means off: a page switched off redirects members home and shows admins a
banner; /library moved to /ebooks; /requests shows the Seerr embed when that
is the chosen source.
"""
import unittest
from unittest import mock

try:
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth import session_manager
    from app.config import settings
    from app import pages
    from app.routers.branding import EMPTY_WIKI_HOOKS, build_branding
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False

ADMIN_SESSION = {"username": "admin", "display_name": "Admin", "is_admin": "true",
                 "auth_method": "simple", "avatar_url": ""}
MEMBER_SESSION = {"username": "sam", "display_name": "Sam", "is_admin": "false",
                  "auth_method": "plex", "avatar_url": ""}
BANNER = "This page is turned off. Only admins can see it."


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class PageRoutesBase(unittest.TestCase):
    def setUp(self):
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        helpers.set_rate_limits(False)
        self.client = TestClient(app)
        self.client.cookies.set(settings.session_cookie_name, "test-session")

    def tearDown(self):
        self.setup_patch.stop()
        helpers.set_rate_limits(True)

    def get(self, path, session, values=None):
        b = build_branding(values or {}, {}, None, dict(EMPTY_WIKI_HOOKS))
        with mock.patch.object(session_manager, "get_session", mock.AsyncMock(return_value=session)), \
             mock.patch.object(pages, "load_context", return_value=(b, {"netdata": False})):
            return self.client.get(path, follow_redirects=False)


class OffMeansOff(PageRoutesBase):
    GATED = [
        ("/requests", "sidebar.enabled_requests"),
        ("/issues", "sidebar.enabled_issues"),
        ("/calendar", "sidebar.enabled_calendar"),
        ("/tickets", "sidebar.enabled_tickets"),
        ("/wiki", "sidebar.enabled_wiki"),
        ("/wiki/some-page", "sidebar.enabled_wiki"),
        ("/ebooks", "sidebar.enabled_library"),
        ("/reader", "sidebar.enabled_library"),
    ]

    def test_members_are_sent_home(self):
        for path, key in self.GATED:
            r = self.get(path, MEMBER_SESSION, {key: "false"})
            self.assertEqual(r.status_code, 302, path)
            self.assertEqual(r.headers["location"], "/", path)

    def test_admins_see_the_page_with_a_banner(self):
        for path, key in self.GATED:
            r = self.get(path, ADMIN_SESSION, {key: "false"})
            self.assertEqual(r.status_code, 200, path)
            if path != "/reader":          # the reader has no shell to carry a banner
                self.assertIn(BANNER, r.text, path)

    def test_pages_that_are_on_have_no_banner(self):
        for path, _key in self.GATED:
            r = self.get(path, MEMBER_SESSION)
            self.assertEqual(r.status_code, 200, path)
            self.assertNotIn(BANNER, r.text, path)

    def test_home_and_news_are_never_gated(self):
        for path in ("/", "/news"):
            r = self.get(path, MEMBER_SESSION, {"sidebar.enabled_home": "false"})
            self.assertEqual(r.status_code, 200, path)


class MovedRoutes(PageRoutesBase):
    def test_library_moves_to_ebooks_keeping_the_query(self):
        r = self.get("/library", MEMBER_SESSION)
        self.assertEqual((r.status_code, r.headers["location"]), (301, "/ebooks"))
        r = self.get("/library?kavita=error&x=1", MEMBER_SESSION)
        self.assertEqual((r.status_code, r.headers["location"]), (301, "/ebooks?kavita=error&x=1"))

    def test_ebooks_serves_the_ebooks_page(self):
        r = self.get("/ebooks", MEMBER_SESSION, {"integration.kavita.url": "http://192.168.1.50:5000"})
        self.assertEqual(r.status_code, 200)
        self.assertIn('data-page="library"', r.text)
        self.assertIn("<title>WebServarr - eBooks</title>", r.text)
        self.assertRegex(r.text, r'<a[^>]*href="/ebooks"[^>]*aria-current="page"')

    def test_requests_embed_redirects(self):
        r = self.get("/requests-embed", MEMBER_SESSION)
        self.assertEqual((r.status_code, r.headers["location"]), (301, "/requests"))

    def test_requests_follows_its_source(self):
        native = self.get("/requests", MEMBER_SESSION)
        self.assertNotIn('id="iframeContainer"', native.text)
        embed = self.get("/requests", MEMBER_SESSION, {"requests.source": "seerr_embed"})
        self.assertIn('id="iframeContainer"', embed.text)
        self.assertRegex(embed.text, r'<a[^>]*href="/requests"[^>]*aria-current="page"')


if __name__ == "__main__":
    unittest.main()
