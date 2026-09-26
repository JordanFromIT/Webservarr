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

    def test_switch_value_is_read_like_the_api_reads_it(self):
        # One reader for page switches: an out-of-band " False " turns the
        # page off here exactly as it turns the page's API off.
        r = self.get("/tickets", MEMBER_SESSION, {"sidebar.enabled_tickets": " False "})
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/"))
        b = build_branding({"sidebar.enabled_tickets": " False "}, {}, None, dict(EMPTY_WIKI_HOOKS))
        self.assertIs(b["sidebar_enabled"]["tickets"], False)

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


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TicketApiGate(unittest.TestCase):
    """The ticket API follows the Tickets page switch, for members only."""

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()
        self.db.close()

    def test_members_get_403_while_tickets_is_off(self):
        helpers.put(self.db, "sidebar.enabled_tickets", "false")
        member = helpers.api_client(self.Session, helpers.MEMBER)
        self.assertEqual(member.get("/api/tickets").status_code, 403)
        r = member.get("/api/tickets/counts")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["detail"], "The ticket system is turned off")
        self.assertEqual(member.post("/api/tickets", data={"title": "t", "description": "d",
                                                           "category": "other"}).status_code, 403)

    def test_admins_keep_access_while_tickets_is_off(self):
        helpers.put(self.db, "sidebar.enabled_tickets", "false")
        admin = helpers.api_client(self.Session, helpers.ADMIN)
        self.assertEqual(admin.get("/api/tickets").status_code, 200)
        self.assertEqual(admin.get("/api/tickets/counts").status_code, 200)
        self.assertEqual(admin.get("/api/admin/tickets").status_code, 200)

    def test_members_have_access_while_tickets_is_on(self):
        helpers.put(self.db, "sidebar.enabled_tickets", "true")
        member = helpers.api_client(self.Session, helpers.MEMBER)
        self.assertEqual(member.get("/api/tickets").status_code, 200)
        self.assertEqual(member.get("/api/tickets/counts").status_code, 200)

    def test_old_flag_no_longer_gates(self):
        helpers.put(self.db, "features.show_tickets", "false")
        member = helpers.api_client(self.Session, helpers.MEMBER)
        self.assertEqual(member.get("/api/tickets").status_code, 200)

    def test_switch_value_is_read_loosely(self):
        helpers.put(self.db, "sidebar.enabled_tickets", " False ")
        member = helpers.api_client(self.Session, helpers.MEMBER)
        self.assertEqual(member.get("/api/tickets").status_code, 403)

    def test_ticket_images_follow_the_switch(self):
        # No such file: a request that passes the gate gets 404.
        path = "/api/uploads/tickets/0123456789abcdef.png"
        helpers.put(self.db, "sidebar.enabled_tickets", "false")
        member = helpers.api_client(self.Session, helpers.MEMBER)
        self.assertEqual(member.get(path).status_code, 403)
        helpers.reset_overrides()
        admin = helpers.api_client(self.Session, helpers.ADMIN)
        self.assertEqual(admin.get(path).status_code, 404)
        helpers.reset_overrides()
        helpers.put(self.db, "sidebar.enabled_tickets", "true")
        member = helpers.api_client(self.Session, helpers.MEMBER)
        self.assertEqual(member.get(path).status_code, 404)

    def test_old_flag_cannot_turn_tickets_back_on(self):
        # An old database may still hold features.show_tickets="true" (the
        # key was retired in v1.11); that must not reopen a Tickets page
        # switched off here.
        helpers.put(self.db, "features.show_tickets", "true")
        helpers.put(self.db, "sidebar.enabled_tickets", "false")
        member = helpers.api_client(self.Session, helpers.MEMBER)
        self.assertEqual(member.get("/api/tickets").status_code, 403)
        self.assertEqual(member.get("/api/tickets/counts").status_code, 403)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class KavitaGate(unittest.TestCase):
    """The Kavita proxy follows the eBooks page switch, for members only."""

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()

    def call(self, user, library_on, path="/kavita/connect", switch=None):
        from app.routers import kavita_proxy
        if switch is None:
            switch = "true" if library_on else "false"
        rows = {"sidebar.enabled_library": switch,
                "integration.kavita.url": ""}     # unconfigured: a request that passes the gate gets 503
        client = helpers.api_client(self.Session, user)
        read = mock.Mock(side_effect=lambda *keys: {k: rows.get(k, "") for k in keys})
        with mock.patch.object(kavita_proxy, "_read_settings", read):
            r = client.get(path, follow_redirects=False)
        self.reads = read.call_count
        return r

    def test_members_are_refused_while_ebooks_is_off(self):
        r = self.call(helpers.MEMBER, False)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["detail"], "eBooks is turned off")
        self.assertEqual(self.call(helpers.MEMBER, False, "/kavita/api/Series/all").status_code, 403)

    def test_switch_value_is_read_loosely(self):
        self.assertEqual(self.call(helpers.MEMBER, None, switch=" False ").status_code, 403)

    def test_admins_pass_the_gate(self):
        self.assertEqual(self.call(helpers.ADMIN, False).status_code, 503)
        self.assertEqual(self.call(helpers.ADMIN, False, "/kavita/api/Series/all").status_code, 503)

    def test_members_pass_when_ebooks_is_on(self):
        self.assertEqual(self.call(helpers.MEMBER, True).status_code, 503)
        self.assertEqual(self.call(helpers.MEMBER, True, "/kavita/api/Series/all").status_code, 503)

    def test_read_settings_returns_every_key_in_one_query(self):
        from app.routers import kavita_proxy
        db = self.Session()
        helpers.put(db, "sidebar.enabled_library", " false ")
        helpers.put(db, "integration.kavita.url", "http://192.168.1.50:5000/")
        db.close()
        with mock.patch.object(kavita_proxy, "SessionLocal", self.Session):
            values = kavita_proxy._read_settings("sidebar.enabled_library",
                                                 "integration.kavita.url", "missing.key")
            self.assertEqual(values, {"sidebar.enabled_library": "false",
                                      "integration.kavita.url": "http://192.168.1.50:5000/",
                                      "missing.key": ""})
            self.assertEqual(kavita_proxy._read_setting("missing.key"), "")
            with self.assertRaises(Exception) as ctx:
                kavita_proxy.kavita_url_for(helpers.MEMBER)
            self.assertEqual(getattr(ctx.exception, "status_code", None), 403)
            self.assertEqual(kavita_proxy.kavita_url_for(helpers.ADMIN), "http://192.168.1.50:5000")

    def test_one_settings_read_per_proxied_request(self):
        # The reader sends every page, image and progress call through the
        # proxy, so the switch is read in the same query as the Kavita URL.
        for user in (helpers.MEMBER, helpers.ADMIN):
            self.call(user, True, "/kavita/api/Series/all")
            self.assertEqual(self.reads, 1, user["username"])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SwitchIsOff(unittest.TestCase):
    """The one reader for a page switch's stored value."""

    def test_values(self):
        from app.settings_registry import switch_is_off
        for value in ("false", "False", " FALSE ", "false\n"):
            self.assertTrue(switch_is_off(value), repr(value))
        for value in (None, "", "true", " True ", "0", "no", "off"):
            self.assertFalse(switch_is_off(value), repr(value))


if __name__ == "__main__":
    unittest.main()


class SettingsSetupFlagsRoute(PageRoutesBase):
    """Polish A fix round 1: only the admin Settings page carries the setup
    flags its skeleton takes its shape from."""

    def test_only_the_admin_settings_page_carries_them(self):
        import json
        import re

        def data_of(text):
            return json.loads(re.search(r'<script id="ws-data" type="application/json">(.*?)</script>', text, re.S).group(1))
        flags = {"plex": True, "seerr": False, "chaptarr": False, "sonarr": True, "radarr": False,
                 "kavita": True, "authentik_url": False, "authentik_secret": False}
        with mock.patch.object(pages, "settings_setup", return_value=flags) as called:
            r = self.get("/settings", ADMIN_SESSION)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(data_of(r.text)["setup"], flags)
            self.assertNotIn("setup", data_of(self.get("/", ADMIN_SESSION).text))
            self.assertEqual(called.call_count, 1)
            self.assertEqual(self.get("/settings", MEMBER_SESSION).status_code, 302)
