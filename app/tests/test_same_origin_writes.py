"""
F3: every state-changing route a signed-in browser calls checks that the
request comes from this site (require_same_origin).

The session cookie is SameSite=Lax, which a sibling subdomain of the same site
still receives a POST with. Without the check, a page on any sibling subdomain
(or XSS on one) could save Settings, post news or edit the wiki as an admin.

The sweep reads the routes from the app's own OpenAPI document, so a write
route added later without the check fails here. The exemptions are routes no
browser on the site calls with a session: the arr webhooks (server to server,
Basic auth), the auth flows that run before a session exists, and the
first-run setup wizard.
"""
import re
import unittest
from unittest import mock

try:
    import httpx
    import requests

    from app.main import app
    from app.routers import kavita_proxy
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False


REFUSED = "Cross-origin request refused"
WRITES = {"post", "put", "patch", "delete"}
EXEMPT = {
    ("post", "/api/webhooks/{app}"),
    ("post", "/auth/plex-start"),
    ("post", "/auth/plex-callback"),
    ("post", "/auth/simple-login"),
    ("post", "/auth/simple-logout"),
    ("post", "/api/setup/complete"),
    ("post", "/api/setup/test-connection"),
}
# The routes the audit named, plus the other writes that lacked the check.
NAMED = [
    ("put", "/api/admin/account"), ("post", "/api/admin/test-connection"),
    ("post", "/api/admin/upload-logo"), ("post", "/api/admin/notifications/send"),
    ("post", "/api/admin/notifications/test-push"),
    ("put", "/api/admin/settings/bulk"), ("post", "/api/admin/settings/import"),
    ("post", "/api/news/"), ("put", "/api/news/1"), ("delete", "/api/news/1"),
    ("post", "/api/wiki/pages"), ("put", "/api/wiki/pages/1"), ("delete", "/api/wiki/pages/1"),
    ("post", "/api/wiki/categories"), ("put", "/api/wiki/categories/1"),
    ("delete", "/api/wiki/categories/1"), ("post", "/api/wiki/images"),
    ("put", "/api/admin/tickets/1"), ("delete", "/api/admin/tickets/1"),
    ("post", "/api/tickets"), ("post", "/api/tickets/1/comments"),
    ("put", "/api/notifications/preferences"), ("post", "/api/notifications/push-subscribe"),
    ("delete", "/api/notifications/push-subscribe"), ("put", "/api/notifications/read-all"),
    ("put", "/api/notifications/1/read"), ("delete", "/api/notifications/1"),
    ("delete", "/api/notifications"),
    ("post", "/api/integrations/issues"), ("post", "/api/integrations/issues/1/comment"),
    ("post", "/api/integrations/seerr-auth"), ("post", "/api/integrations/seerr-request"),
    ("post", "/api/integrations/chaptarr-request"), ("post", "/api/request-status/refresh"),
]
CROSS_ORIGINS = ({"Origin": "https://evil.example"}, {"Origin": "https://other.testserver"},
                 {"Origin": "null"}, {"Referer": "https://evil.example/page"}, {})


def _concrete(path: str) -> str:
    """The path with each {param} filled in (a number fits every id and slug)."""
    return re.sub(r"\{[^}]+\}", "1", path)


def _write_operations():
    for path, item in app.openapi()["paths"].items():
        for method in item:
            if method in WRITES and (method, path) not in EXEMPT:
                yield method, path


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SameOriginWrites(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.client = helpers.api_client(self.Session, helpers.ADMIN)
        self.addCleanup(helpers.reset_overrides)
        # Nothing here may reach a real service or the real database: every
        # outbound call fails and a push goes nowhere.
        offline = httpx.ConnectError("offline in tests")
        sent = mock.AsyncMock(return_value={"attempted": 0, "succeeded": 0})
        for patch in (mock.patch("app.routers.setup.is_setup_completed", return_value=True),
                      mock.patch("app.routers.admin.dispatch_push", sent),
                      mock.patch("app.routers.request_status.request_status.refresh",
                                 mock.AsyncMock(side_effect=RuntimeError("not in tests"))),
                      mock.patch.object(httpx.AsyncClient, "send", side_effect=offline),
                      mock.patch.object(requests.Session, "send", side_effect=requests.ConnectionError)):
            patch.start()
            self.addCleanup(patch.stop)

    def send(self, method, path, headers):
        return self.client.request(method, path, json={}, headers=headers)

    def test_the_sweep_finds_the_named_routes(self):
        found = {(m, _concrete(p)) for m, p in _write_operations()}
        for method, path in NAMED:
            with self.subTest(method=method, path=path):
                self.assertIn((method, path), found)

    def test_every_write_refuses_another_origin_and_no_origin(self):
        for method, path in _write_operations():
            for headers in CROSS_ORIGINS:
                with self.subTest(method=method, path=path, headers=headers):
                    r = self.send(method, _concrete(path), headers)
                    self.assertEqual(r.status_code, 403, r.text)
                    self.assertEqual(r.json().get("detail"), REFUSED)

    def test_the_site_itself_gets_past_the_check(self):
        for method, path in NAMED:
            for headers in (helpers.SAME_ORIGIN, {"Referer": "https://testserver/settings"}):
                with self.subTest(method=method, path=path, headers=headers):
                    r = self.send(method, path, headers)
                    self.assertNotEqual(r.json().get("detail") if r.content else None, REFUSED, r.text)


class _ForwardNothing:
    asked = []

    def __init__(self, *args, **kwargs):
        pass

    def build_request(self, method, url, **kwargs):
        return (method, url)

    async def send(self, request, stream=False):
        _ForwardNothing.asked.append(request)

        class Upstream:
            status_code = 200
            headers = {"content-type": "application/json"}

            async def aiter_bytes(self, chunk_size=0):
                yield b"{}"

            async def aclose(self):
                pass
        return Upstream()

    async def aclose(self):
        pass


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class KavitaProxyWrites(unittest.TestCase):
    """The reader's writes (progress, bookmarks) go through the Kavita proxy:
    they must come from the site. Its reads stay open to <img> and CSS, which
    send no Origin."""

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.client = helpers.api_client(self.Session, dict(helpers.MEMBER, kavita_token="jwt",
                                                            kavita_base="http://kavita.invalid:5000"))
        self.addCleanup(helpers.reset_overrides)
        _ForwardNothing.asked = []
        for patch in (mock.patch("app.routers.setup.is_setup_completed", return_value=True),
                      mock.patch.object(kavita_proxy, "kavita_url_for", return_value="http://kavita.invalid:5000"),
                      mock.patch.object(kavita_proxy.httpx, "AsyncClient", _ForwardNothing)):
            patch.start()
            self.addCleanup(patch.stop)

    def test_a_write_from_elsewhere_is_403_and_not_forwarded(self):
        for method in ("post", "put", "patch", "delete"):
            for headers in CROSS_ORIGINS:
                with self.subTest(method=method, headers=headers):
                    r = self.client.request(method, "/kavita/api/Series/all-v2", json={}, headers=headers)
                    self.assertEqual(r.status_code, 403)
                    self.assertEqual(_ForwardNothing.asked, [])

    def test_a_write_from_the_site_and_a_read_without_origin_are_forwarded(self):
        r = self.client.post("/kavita/api/Series/all-v2", json={}, headers=helpers.SAME_ORIGIN)
        self.assertEqual(r.status_code, 200)
        r = self.client.get("/kavita/api/Series/all-v2")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(_ForwardNothing.asked), 2)
