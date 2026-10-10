"""
The Plex share client (spec section 7), against a fake plex.tv on an
httpx.MockTransport. Any call the fake doesn't expect fails the test, so the
client can never reach the real plex.tv here.
"""
import asyncio
import json
import traceback
import unittest
from unittest import mock

try:
    import httpx  # noqa: F401
    from fastapi import FastAPI  # noqa: F401
    HAVE_APP = True
except ImportError:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

if HAVE_APP:
    import httpx
    from app.integrations import plex_share
    from app.tests import helpers

ADMIN_TOKEN = "ADMIN-TOKEN-SENTINEL-77"
MID = "machine-1"
ACCOUNT = {"plex_account_id": "5551", "plex_username": "newperson"}
SECTIONS = {"librarySections": [{"id": 901, "key": "1", "title": "Movies", "type": "movie"},
                                {"id": 902, "key": "2", "title": "TV", "type": "show"}]}
CREATE = f"https://plex.tv/api/servers/{MID}/shared_servers"


class FakePlex:
    """plex.tv as far as the client uses it. A POST that succeeds adds the
    share to the pending list (unless confirm is False)."""

    def __init__(self, accepted=(), pending=(), post_status=201, confirm=True, post_error=None, listing_status=200):
        self.accepted, self.pending = list(accepted), list(pending)
        self.post_status, self.confirm, self.post_error = post_status, confirm, post_error
        self.listing_status = listing_status
        self.calls, self.posted = [], []

    def handler(self, request):
        url = str(request.url)
        self.calls.append((request.method, url, request.headers.get("x-plex-token")))
        if request.method == "GET" and url == f"https://plex.tv/api/v2/servers/{MID}":
            return httpx.Response(200, json=SECTIONS)
        if request.method == "GET" and url == "https://clients.plex.tv/api/v2/shared_servers/owned/accepted":
            return httpx.Response(self.listing_status, json=self.accepted)
        if request.method == "GET" and url == "https://clients.plex.tv/api/v2/shared_servers/owned/pending":
            return httpx.Response(self.listing_status, json=self.pending)
        if request.method == "POST" and url == CREATE:
            self.posted.append(json.loads(request.content))
            if self.post_error:
                raise self.post_error
            if self.post_status in (200, 201) and self.confirm:
                self.pending.append({"invitedId": 5551, "machineIdentifier": MID, "inviteToken": "INVITE-SECRET"})
            return httpx.Response(self.post_status, json={"inviteToken": "INVITE-SECRET", "id": 1})
        raise AssertionError(f"unexpected Plex call: {request.method} {url}")


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class ShareClient(unittest.TestCase):
    def use(self, plex):
        self.plex = plex
        server = plex_share.PlexServer(MID, {"Accept": "application/json", "X-Plex-Token": ADMIN_TOKEN})
        for p in (mock.patch.object(plex_share, "_server", mock.AsyncMock(return_value=server)),
                  mock.patch.object(plex_share, "_client", lambda: httpx.AsyncClient(
                      transport=httpx.MockTransport(plex.handler), timeout=plex_share.TIMEOUT))):
            p.start()
            self.addCleanup(p.stop)
        return plex

    def share(self, keys=("1",)):
        return asyncio.run(plex_share.share_server(dict(ACCOUNT), list(keys)))

    def posts(self):
        return [c for c in self.plex.calls if c[0] == "POST"]

    def test_an_existing_share_means_no_post(self):
        for where in ("accepted", "pending"):
            with self.subTest(where):
                entry = {"invitedId": 5551, "machineIdentifier": MID}
                self.use(FakePlex(**{where: [entry]}))
                self.assertEqual(self.share(), ("existing", None))
                self.assertEqual(self.posts(), [])

    def test_a_share_for_another_server_or_account_is_not_existing(self):
        self.use(FakePlex(accepted=[{"invitedId": 5551, "machineIdentifier": "other"},
                                    {"invitedId": 1, "machineIdentifier": MID}]))
        self.assertEqual(self.share(), ("shared", None))
        self.assertEqual(len(self.posts()), 1)

    def test_shared_sends_what_python_plexapi_sends_and_is_confirmed(self):
        self.use(FakePlex())
        self.assertEqual(self.share(("1", "2")), ("shared", None))
        self.assertEqual(self.plex.posted, [{
            "server_id": MID,
            "shared_server": {"library_section_ids": [901, 902], "invited_email": "newperson"},
            "sharing_settings": {"allowSync": "0", "allowCameraUpload": "0", "allowChannels": "0",
                                 "filterMovies": "", "filterTelevision": "", "filterMusic": ""},
        }])
        for method, url, token in self.plex.calls:
            self.assertEqual(token, ADMIN_TOKEN, url)
            self.assertNotIn(ADMIN_TOKEN, url)

    def test_a_refusal_is_failed_with_the_status_and_never_retried(self):
        for status in (400, 401, 422, 500, 503):
            with self.subTest(status):
                self.use(FakePlex(post_status=status))
                self.assertEqual(self.share(), ("failed", f"Plex refused the share (HTTP {status})"))
                self.assertEqual(len(self.posts()), 1)

    def test_no_confirming_listing_is_failed(self):
        self.use(FakePlex(confirm=False))
        self.assertEqual(self.share(), ("failed", "Plex didn't confirm the share"))

    def test_a_dropped_post_is_failed_once(self):
        self.use(FakePlex(post_error=httpx.ConnectError("down")))
        self.assertEqual(self.share(), ("failed", "Plex didn't answer the share"))
        self.assertEqual(len(self.posts()), 1)

    def test_a_library_no_longer_on_the_server_is_failed_without_a_post(self):
        self.use(FakePlex())
        self.assertEqual(self.share(("1", "77")), ("failed", "Those libraries aren't on the server any more"))
        self.assertEqual(self.posts(), [])

    def test_plex_not_configured_is_failed_with_its_reason(self):
        with mock.patch.object(plex_share, "_server",
                               mock.AsyncMock(side_effect=plex_share.PlexShareUnavailable("Plex isn't connected"))):
            self.assertEqual(asyncio.run(plex_share.share_server(dict(ACCOUNT), ["1"])),
                             ("failed", "Plex isn't connected"))

    def test_no_reason_carries_a_token(self):
        for plex in (FakePlex(post_status=400), FakePlex(confirm=False), FakePlex(listing_status=500)):
            self.use(plex)
            state, reason = self.share()
            self.assertEqual(state, "failed")
            self.assertNotIn(ADMIN_TOKEN, reason)
            self.assertNotIn("INVITE-SECRET", reason)
            self.assertLessEqual(len(reason), 200)

    def test_list_libraries(self):
        self.use(FakePlex())
        self.assertEqual(asyncio.run(plex_share.list_libraries()),
                         [{"key": "1", "title": "Movies", "type": "movie"}, {"key": "2", "title": "TV", "type": "show"}])

    def test_find_share(self):
        self.use(FakePlex(accepted=[{"invitedId": 5551, "machineIdentifier": MID}]))
        self.assertEqual(asyncio.run(plex_share.find_share("5551")), "accepted")
        self.use(FakePlex(pending=[{"invitedId": "5551", "machineIdentifier": MID}]))
        self.assertEqual(asyncio.run(plex_share.find_share("5551")), "pending")
        self.use(FakePlex())
        self.assertIsNone(asyncio.run(plex_share.find_share("5551")))
        self.use(FakePlex(listing_status=500))
        with self.assertRaises(plex_share.PlexShareUnavailable):
            asyncio.run(plex_share.find_share("5551"))


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class NothingLeaksThroughAnError(unittest.TestCase):
    """A PlexShareUnavailable that escapes the module carries no httpx error
    (whose text names the URL, so the machine id), not even in a traceback.
    The fake's errors and bodies name the machine id and the token on purpose."""

    @staticmethod
    def fail_with(failure):
        def handler(request):
            leak = f"{request.url} {request.headers.get('x-plex-token')}"
            if failure == "connect":
                raise httpx.ConnectError(f"cannot reach {leak}", request=request)
            if failure == "timeout":
                raise httpx.ReadTimeout(f"timed out on {leak}", request=request)
            if failure == "unreadable":
                return httpx.Response(200, text=f"<MediaContainer>{leak}</MediaContainer>")
            return httpx.Response(503, text=leak)
        return handler

    def caught(self, failure, call):
        server = plex_share.PlexServer(MID, {"Accept": "application/json", "X-Plex-Token": ADMIN_TOKEN})
        with mock.patch.object(plex_share, "_server", mock.AsyncMock(return_value=server)), \
             mock.patch.object(plex_share, "_client", lambda: httpx.AsyncClient(
                 transport=httpx.MockTransport(self.fail_with(failure)), timeout=plex_share.TIMEOUT)):
            with self.assertRaises(plex_share.PlexShareUnavailable) as caught:
                asyncio.run(call())
        return caught.exception

    def test_each_failure_path(self):
        expected = {"connect": "Plex didn't answer", "timeout": "Plex didn't answer",
                    "non-200": "Plex answered HTTP 503", "unreadable": "Plex sent something unreadable"}
        calls = {"list_libraries": plex_share.list_libraries, "find_share": lambda: plex_share.find_share("5551")}
        for failure, text in expected.items():
            for name, call in calls.items():
                with self.subTest(failure=failure, call=name):
                    exc = self.caught(failure, call)
                    self.assertEqual(str(exc), text)
                    self.assertIsNone(exc.__cause__)
                    if failure == "non-200":   # raised outside any except: nothing to suppress
                        self.assertIsNone(exc.__context__)
                    else:
                        self.assertTrue(exc.__suppress_context__)
                    shown = "".join(traceback.format_exception(exc))
                    self.assertNotIn(MID, shown)
                    self.assertNotIn(ADMIN_TOKEN, shown)


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class ServerContext(unittest.TestCase):
    """_server: the admin token and exactly one machine id, or a reason."""

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        p = mock.patch.object(plex_share, "SessionLocal", self.Session)
        p.start()
        self.addCleanup(p.stop)

    def test_no_token_is_not_connected(self):
        with mock.patch.object(plex_share.integration_config, "read", return_value={}):
            with self.assertRaises(plex_share.PlexShareUnavailable) as caught:
                asyncio.run(plex_share._server())
        self.assertEqual(str(caught.exception), "Plex isn't connected")

    def test_not_exactly_one_server_id(self):
        values = {"integration.plex.url": "http://192.168.1.2:32400", "integration.plex.token": ADMIN_TOKEN}
        for ids in (set(), {"a", "b"}):
            with self.subTest(ids=sorted(ids)), \
                 mock.patch.object(plex_share.integration_config, "read", return_value=values), \
                 mock.patch("app.routers.auth._fetch_configured_server_identifiers", mock.AsyncMock(return_value=ids)):
                with self.assertRaises(plex_share.PlexShareUnavailable):
                    asyncio.run(plex_share._server())

    def test_one_server_id(self):
        values = {"integration.plex.url": "http://192.168.1.2:32400", "integration.plex.token": ADMIN_TOKEN}
        with mock.patch.object(plex_share.integration_config, "read", return_value=values), \
             mock.patch("app.routers.auth._fetch_configured_server_identifiers", mock.AsyncMock(return_value={MID})):
            server = asyncio.run(plex_share._server())
        self.assertEqual(server.machine_id, MID)
        self.assertEqual(server.headers["X-Plex-Token"], ADMIN_TOKEN)
        self.assertIn("X-Plex-Client-Identifier", server.headers)


if __name__ == "__main__":
    unittest.main()
