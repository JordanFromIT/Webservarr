"""
The Kavita handshake redirect allow-list resolves Authentik like the OIDC client.

/kavita/connect relays Kavita's redirect to the Authentik authorize endpoint and
refuses any other origin (open-redirect guard). Installs configure Authentik in
the settings table, not the AUTHENTIK_URL env var, so an allow-list built from
the env var alone refused every legitimate redirect. These tests pin DB-first,
env-fallback resolution and that foreign origins stay refused.
"""
import unittest
from unittest import mock

try:
    from app.routers import kavita_proxy
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False


KAVITA = "http://kavita.invalid:5000"
AUTHORIZE = "https://auth.example.com/application/o/authorize/?client_id=x&state=y"


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class LocationAllowed(unittest.TestCase):
    def _allowed(self, location, db_url="", env_url=""):
        rows = {"integration.authentik.url": db_url}
        with mock.patch.object(kavita_proxy, "_read_setting",
                               side_effect=lambda key: rows.get(key, "")), \
             mock.patch.object(kavita_proxy.settings, "authentik_url", env_url):
            return kavita_proxy._location_allowed(location, KAVITA)

    def test_db_url_allows_authorize_endpoint(self):
        self.assertTrue(self._allowed(AUTHORIZE, db_url="https://auth.example.com"))

    def test_db_url_with_trailing_slash_allows_authorize_endpoint(self):
        self.assertTrue(self._allowed(AUTHORIZE, db_url="https://auth.example.com/"))

    def test_env_fallback_allows_authorize_endpoint(self):
        self.assertTrue(self._allowed(AUTHORIZE, env_url="https://auth.example.com"))

    def test_db_url_takes_precedence_over_env(self):
        self.assertTrue(self._allowed(AUTHORIZE, db_url="https://auth.example.com",
                                      env_url="https://old-auth.example.com"))
        self.assertFalse(self._allowed("https://old-auth.example.com/authorize",
                                       db_url="https://auth.example.com",
                                       env_url="https://old-auth.example.com"))

    def test_foreign_origin_rejected(self):
        self.assertFalse(self._allowed("https://evil.example/authorize",
                                       db_url="https://auth.example.com"))
        self.assertFalse(self._allowed("https://evil.example/authorize",
                                       env_url="https://auth.example.com"))

    def test_same_host_other_scheme_or_port_rejected(self):
        self.assertFalse(self._allowed("http://auth.example.com/authorize",
                                       db_url="https://auth.example.com"))
        self.assertFalse(self._allowed("https://auth.example.com:8443/authorize",
                                       db_url="https://auth.example.com"))

    def test_nothing_configured_allows_only_kavita_itself(self):
        self.assertTrue(self._allowed(KAVITA + "/login"))
        self.assertFalse(self._allowed(AUTHORIZE))
        self.assertFalse(self._allowed("https://evil.example/"))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class GetAuthentikUrl(unittest.TestCase):
    def test_reads_the_settings_row(self):
        with mock.patch.object(kavita_proxy, "_read_setting",
                               return_value="https://auth.example.com/"), \
             mock.patch.object(kavita_proxy.settings, "authentik_url", ""):
            self.assertEqual(kavita_proxy.get_authentik_url(), "https://auth.example.com/")

    def test_falls_back_to_env_when_row_empty(self):
        with mock.patch.object(kavita_proxy, "_read_setting", return_value=""), \
             mock.patch.object(kavita_proxy.settings, "authentik_url",
                               "https://auth.example.com"):
            self.assertEqual(kavita_proxy.get_authentik_url(), "https://auth.example.com")


class _FakeResponse:
    def __init__(self, payload):
        self.status_code = 200
        self._payload = payload

    def json(self):
        return self._payload


class _FakeKavita:
    """Stands in for httpx.AsyncClient: the callback, the account, the JWT."""
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def request(self, *args, **kwargs):
        return _FakeResponse({})

    async def get(self, *args, **kwargs):
        return _FakeResponse({"apiKey": "key"})

    async def post(self, *args, **kwargs):
        return _FakeResponse({"token": "jwt"})


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class HandshakeLandsOnBooks(unittest.TestCase):
    """The Kavita sign-in finishes on the Books page itself (/books), not on
    the old /ebooks or /library addresses, which would cost a second redirect."""

    def setUp(self):
        from fastapi.testclient import TestClient
        from app.config import settings
        from app.main import app
        from app.tests import helpers
        self.helpers = helpers
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        helpers.set_rate_limits(False)
        self.client = TestClient(app)
        self.client.cookies.set(settings.session_cookie_name, "test-session")

    def tearDown(self):
        self.setup_patch.stop()
        self.helpers.set_rate_limits(True)

    def finish(self, kavita_cookies, session=None, library="true"):
        sm = kavita_proxy.session_manager
        rows = {"integration.kavita.url": KAVITA, "sidebar.enabled_library": library}
        self.update = mock.AsyncMock()
        with mock.patch.object(sm, "get_session", mock.AsyncMock(return_value=session or {"username": "sam"})), \
             mock.patch.object(sm, "update_session", self.update), \
             mock.patch.object(kavita_proxy, "_read_settings",
                               side_effect=lambda *keys: {k: rows.get(k, "") for k in keys}), \
             mock.patch.object(kavita_proxy, "collect_cookies", return_value=kavita_cookies), \
             mock.patch.object(kavita_proxy.httpx, "AsyncClient", _FakeKavita):
            return self.client.post("/signin-oidc", data={"code": "c"}, follow_redirects=False)

    def test_success_lands_on_books(self):
        r = self.finish(".AspNetCore.Cookies=abc")
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/books"))

    def test_failure_lands_on_books_with_the_error_flag(self):
        r = self.finish("")
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/books?kavita=error"))

    def test_members_get_no_token_while_ebooks_is_off(self):
        # eBooks switched off mid-handshake: go home (the page gate's answer)
        # and store no Kavita token in the session.
        r = self.finish(".AspNetCore.Cookies=abc", {"username": "sam", "is_admin": "false"}, " False ")
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/"))
        self.update.assert_not_called()

    def test_the_token_is_stored_with_the_address_it_came_from(self):
        # R133: the proxy sends a token only to that address.
        self.finish(".AspNetCore.Cookies=abc")
        fields = self.update.await_args.args[1]
        self.assertEqual(fields, {"kavita_token": "jwt", "kavita_api_key": "key", "kavita_base": KAVITA})

    def test_admins_finish_the_handshake_while_ebooks_is_off(self):
        r = self.finish(".AspNetCore.Cookies=abc", {"username": "admin", "is_admin": "true"}, "false")
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/books"))
        self.update.assert_called_once()


class _DownKavita(_FakeKavita):
    async def get(self, *args, **kwargs):
        import httpx
        raise httpx.ConnectError("down")


class _SilentKavita(_FakeKavita):
    """Answers /oidc/login without a redirect."""
    async def get(self, *args, **kwargs):
        r = _FakeResponse({})
        r.headers = {}
        return r


class _ElsewhereKavita(_FakeKavita):
    async def get(self, *args, **kwargs):
        r = _FakeResponse({})
        r.headers = {"location": "https://evil.example/authorize"}
        return r


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ConnectFailureLandsOnBooks(unittest.TestCase):
    """The hand-off that cannot start sends the person back to Books with the
    failure flag (which stops it asking again), not to a raw 503 that would
    lose what Books already shows."""

    def setUp(self):
        from app.tests import helpers
        self.helpers = helpers
        self.Session = helpers.make_sessionmaker()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        helpers.set_rate_limits(False)

    def tearDown(self):
        self.helpers.reset_overrides()
        self.setup_patch.stop()
        self.helpers.set_rate_limits(True)

    def connect(self, fake):
        client = self.helpers.api_client(self.Session, self.helpers.MEMBER)
        with mock.patch.object(kavita_proxy, "kavita_url_for", return_value=KAVITA), \
             mock.patch.object(kavita_proxy.httpx, "AsyncClient", fake):
            return client.get("/kavita/connect", follow_redirects=False)

    def test_kavita_not_answering(self):
        r = self.connect(_DownKavita)
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/books?kavita=error"))

    def test_no_redirect_from_the_login(self):
        r = self.connect(_SilentKavita)
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/books?kavita=error"))

    def test_a_redirect_to_another_origin(self):
        r = self.connect(_ElsewhereKavita)
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/books?kavita=error"))

    def test_not_configured_is_still_a_503(self):
        client = self.helpers.api_client(self.Session, self.helpers.MEMBER)
        with mock.patch.object(kavita_proxy, "kavita_url_for", return_value=None):
            r = client.get("/kavita/connect", follow_redirects=False)
        self.assertEqual(r.status_code, 503)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ReturnPath(unittest.TestCase):
    """T4H1: the hand-off comes back to the page it started from, and only to
    a page under /books or /reader of this site."""

    GOOD = {
        "/books": "/books",
        "/books/4": "/books/4",
        "/books/series?name=Harry%20Potter": "/books/series?name=Harry%20Potter",
        "/books/person?role=author&name=Le%20Guin%2C%20Ursula%20K.": "/books/person?role=author&name=Le%20Guin%2C%20Ursula%20K.",
        "/reader?seriesId=104&chapterId=136": "/reader?seriesId=104&chapterId=136",
        "/books/4#x": "/books/4",                      # the fragment is dropped
    }
    BAD = [
        None, "", "books/4", "/", "/settings", "/api/books/4", "/booksx", "/readers", "//evil.example/books",
        "///evil.example", "/\\evil.example", "/books\\..\\x", "https://evil.example/books", "http:/books",
        "javascript:alert(1)", "/books/../settings", "/books/%2e%2e/settings", "/books/%2E%2E/x", "/books/a%2Fb",
        "/books/a%5Cb", "/books/%00", "/books/ x", "/books/\tx", "/books/\nx", "/books/\r\nSet-Cookie: a=b",
        "/books/\u00e9", "/books/" + "a" * 600, 5, ["/books"], "/books?next=//evil.example/\u0000",
    ]

    def test_a_page_of_this_site_under_books_or_reader_is_kept(self):
        for given, kept in self.GOOD.items():
            with self.subTest(given=given):
                self.assertEqual(kavita_proxy.safe_return_path(given), kept)

    def test_anything_else_is_books(self):
        for given in self.BAD:
            with self.subTest(given=given):
                self.assertEqual(kavita_proxy.safe_return_path(given), "/books")

    def test_the_error_flag_joins_a_query_or_starts_one(self):
        self.assertEqual(kavita_proxy._with_error_flag("/books/4"), "/books/4?kavita=error")
        self.assertEqual(kavita_proxy._with_error_flag("/books/series?name=X"), "/books/series?name=X&kavita=error")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class HandOffReturns(unittest.TestCase):
    """T4H1: /kavita/connect?return=<path> keeps the path in the session,
    /signin-oidc goes back to it (also on failure, with the flag) and forgets it."""

    def setUp(self):
        from fastapi.testclient import TestClient
        from app.config import settings
        from app.main import app
        from app.tests import helpers
        self.helpers = helpers
        self.Session = helpers.make_sessionmaker()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        helpers.set_rate_limits(False)
        self.callback_client = TestClient(app)
        self.callback_client.cookies.set(settings.session_cookie_name, "test-session")
        self.cookie = settings.session_cookie_name

    def tearDown(self):
        self.helpers.reset_overrides()
        self.setup_patch.stop()
        self.helpers.set_rate_limits(True)

    def start(self, fake, query):
        client = self.helpers.api_client(self.Session, self.helpers.MEMBER)
        client.cookies.set(self.cookie, "sid-1")
        self.update = mock.AsyncMock()
        with mock.patch.object(kavita_proxy, "kavita_url_for", return_value=KAVITA), \
             mock.patch.object(kavita_proxy.session_manager, "update_session", self.update), \
             mock.patch.object(kavita_proxy.httpx, "AsyncClient", fake):
            return client.get("/kavita/connect" + query, follow_redirects=False)

    def finish(self, kavita_cookies, session):
        sm = kavita_proxy.session_manager
        rows = {"integration.kavita.url": KAVITA, "sidebar.enabled_library": "true"}
        self.update = mock.AsyncMock()
        with mock.patch.object(sm, "get_session", mock.AsyncMock(return_value=session)), \
             mock.patch.object(sm, "update_session", self.update), \
             mock.patch.object(kavita_proxy, "_read_settings",
                               side_effect=lambda *keys: {k: rows.get(k, "") for k in keys}), \
             mock.patch.object(kavita_proxy, "collect_cookies", return_value=kavita_cookies), \
             mock.patch.object(kavita_proxy.httpx, "AsyncClient", _FakeKavita):
            return self.callback_client.post("/signin-oidc", data={"code": "c"}, follow_redirects=False)

    def test_the_page_it_started_from_is_kept_in_the_session(self):
        self.start(_ElsewhereKavita, "?return=/books/4")
        self.update.assert_any_await("sid-1", {"kavita_return": "/books/4"})

    def test_no_return_or_a_bad_one_keeps_books(self):
        for query in ("", "?return=", "?return=https://evil.example/", "?return=//evil.example", "?return=/settings"):
            with self.subTest(query=query):
                self.start(_ElsewhereKavita, query)
                self.update.assert_any_await("sid-1", {"kavita_return": "/books"})

    def test_a_hand_off_that_cannot_start_goes_back_to_the_page_with_the_flag(self):
        for fake in (_DownKavita, _SilentKavita, _ElsewhereKavita):
            r = self.start(fake, "?return=/books/4")
            self.assertEqual((r.status_code, r.headers["location"]), (302, "/books/4?kavita=error"), fake.__name__)
            r = self.start(fake, "?return=/books/series%3Fname%3DX")
            self.assertEqual(r.headers["location"], "/books/series?name=X&kavita=error", fake.__name__)

    def test_success_goes_back_to_the_page_and_forgets_it(self):
        r = self.finish(".AspNetCore.Cookies=abc", {"username": "sam", "kavita_return": "/books/4"})
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/books/4"))
        calls = [c.args[1] for c in self.update.await_args_list]
        self.assertIn({"kavita_return": ""}, calls)
        self.assertEqual(calls[-1], {"kavita_token": "jwt", "kavita_api_key": "key", "kavita_base": KAVITA})

    def test_failure_goes_back_to_the_page_with_the_flag(self):
        r = self.finish("", {"username": "sam", "kavita_return": "/reader?seriesId=1&chapterId=2"})
        self.assertEqual(r.headers["location"], "/reader?seriesId=1&chapterId=2&kavita=error")
        self.assertIn({"kavita_return": ""}, [c.args[1] for c in self.update.await_args_list])

    def test_a_stored_path_that_is_not_safe_is_books(self):
        r = self.finish(".AspNetCore.Cookies=abc", {"username": "sam", "kavita_return": "https://evil.example/"})
        self.assertEqual(r.headers["location"], "/books")
        r = self.finish("", {"username": "sam", "kavita_return": "//evil.example"})
        self.assertEqual(r.headers["location"], "/books?kavita=error")


class _FakeUpstream:
    status_code = 200
    headers = {"content-type": "application/json"}

    async def aiter_bytes(self, chunk_size=0):
        yield b"{}"

    async def aread(self):
        return b"<p>page</p>"

    async def aclose(self):
        pass


class _RecordingProxyClient:
    """Stands in for the proxy's streaming client: records what it was asked for."""
    asked = []

    def __init__(self, *args, **kwargs):
        pass

    def build_request(self, method, url, **kwargs):
        return (method, url)

    async def send(self, request, stream=False):
        _RecordingProxyClient.asked.append(request[1])
        return _FakeUpstream()

    async def aclose(self):
        pass


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ChapterVisibility(unittest.TestCase):
    """T4H5: Kavita's book endpoints do not check library access, so the proxy
    asks first whether the caller's own account may see the chapter's series."""

    def setUp(self):
        from app.tests import helpers
        self.helpers = helpers
        self.Session = helpers.make_sessionmaker()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        helpers.set_rate_limits(False)
        _RecordingProxyClient.asked = []
        user = dict(helpers.MEMBER, kavita_token="jwt-sam", kavita_base=KAVITA)
        self.client = helpers.api_client(self.Session, user)

    def tearDown(self):
        self.helpers.reset_overrides()
        self.setup_patch.stop()
        self.helpers.set_rate_limits(True)

    def fetch(self, path, visible=True, catalog=None, raises=None):
        check = mock.AsyncMock(return_value=visible, side_effect=raises)
        with mock.patch.object(kavita_proxy, "kavita_url_for", return_value=KAVITA), \
             mock.patch.object(kavita_proxy.kavita_api, "chapter_is_visible", check), \
             mock.patch.object(kavita_proxy, "_catalog_series_of_chapter", return_value=catalog), \
             mock.patch.object(kavita_proxy.httpx, "AsyncClient", _RecordingProxyClient):
            r = self.client.get("/kavita/" + path)
        self.check = check
        return r

    def test_a_visible_chapter_is_served(self):
        for path in ("api/Book/136/book-info", "api/Book/136/book-page?page=0", "api/book/136/chapters",
                     "api/Book/136/book-resources?file=a.png"):
            with self.subTest(path=path):
                _RecordingProxyClient.asked = []
                r = self.fetch(path, visible=True, catalog=104)
                self.assertEqual(r.status_code, 200)
                self.assertEqual(len(_RecordingProxyClient.asked), 1)
                self.check.assert_awaited_once_with(KAVITA, "jwt-sam", 136, 104)

    def test_a_hidden_chapter_is_404_and_never_asked_of_kavita(self):
        for path in ("api/Book/136/book-info", "api/Book/136/book-page?page=3", "api/Book/136/chapters",
                     "api/book/136/book-resources?file=a.png", "api/Book/136"):
            with self.subTest(path=path):
                _RecordingProxyClient.asked = []
                r = self.fetch(path, visible=False, catalog=104)
                self.assertEqual(r.status_code, 404)
                self.assertEqual(_RecordingProxyClient.asked, [])

    def test_a_chapter_nobody_knows_is_404(self):
        r = self.fetch("api/Book/999999/book-info", visible=False, catalog=None)
        self.assertEqual(r.status_code, 404)
        self.check.assert_awaited_once_with(KAVITA, "jwt-sam", 999999, None)
        self.assertEqual(_RecordingProxyClient.asked, [])

    def test_kavita_refusing_the_token_is_401_and_not_answering_is_503(self):
        r = self.fetch("api/Book/136/book-info", raises=kavita_proxy.kavita_api.KavitaTokenRefused("expired"))
        self.assertEqual(r.status_code, 401)
        r = self.fetch("api/Book/136/book-info", raises=kavita_proxy.kavita_api.KavitaUnavailable("down"))
        self.assertEqual(r.status_code, 503)
        self.assertEqual(_RecordingProxyClient.asked, [])

    def test_other_paths_are_not_asked_about(self):
        for path in ("api/Series/series-detail?seriesId=5", "api/Reader/get-progress?chapterId=136",
                     "api/image/chapter-cover?chapterId=1"):
            with self.subTest(path=path):
                r = self.fetch(path)
                self.assertEqual(r.status_code, 200)
                self.check.assert_not_awaited()

    def test_nothing_is_remembered_between_requests(self):
        self.fetch("api/Book/136/book-info", visible=True)
        self.fetch("api/Book/136/book-info", visible=False)
        self.assertEqual(self.check.await_count, 1)         # asked again, answered fresh
        self.assertEqual(self.fetch("api/Book/136/book-info", visible=False).status_code, 404)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ChapterIsVisible(unittest.IsolatedAsyncioTestCase):
    """The check itself, against a scripted Kavita: the series comes from the
    catalog or from the chapter's own book-info, and must be in the list Kavita
    gives this person."""

    def client(self, info=None, listed=(1, 2), info_status=200, list_status=200):
        calls = []

        class Resp:
            def __init__(self, status, body, headers=None):
                self.status_code, self._body, self.headers = status, body, headers or {}

            def json(self):
                return self._body

        class Client:
            async def __aenter__(self_):
                return self_

            async def __aexit__(self_, *exc):
                return False

            async def get(self_, url, **kwargs):
                calls.append(("GET", url))
                return Resp(info_status, info)

            async def request(self_, method, url, **kwargs):
                calls.append((method, url))
                return Resp(list_status, [{"id": i} for i in listed], {"pagination": '{"totalPages": 1}'})

        return Client(), calls

    async def run_check(self, chapter, known, **kwargs):
        from app.integrations import kavita
        fake, calls = self.client(**kwargs)
        with mock.patch.object(kavita, "_user_client", return_value=fake):
            return await kavita.chapter_is_visible(KAVITA, "jwt", chapter, known), calls

    async def test_a_series_in_the_callers_list_is_visible_and_the_catalog_saves_a_call(self):
        ok, calls = await self.run_check(136, 2)
        self.assertTrue(ok)
        self.assertEqual([m for m, _u in calls], ["POST"])         # the list only

    async def test_a_series_not_in_the_list_is_hidden(self):
        ok, _calls = await self.run_check(136, 77)
        self.assertFalse(ok)

    async def test_a_chapter_the_catalog_lacks_names_its_series_in_book_info(self):
        ok, calls = await self.run_check(500, None, info={"seriesId": 2, "pages": 3})
        self.assertTrue(ok)
        self.assertEqual([m for m, _u in calls], ["GET", "POST"])
        ok, _calls = await self.run_check(500, None, info={"seriesId": 77})
        self.assertFalse(ok)

    async def test_a_foreign_or_unreadable_chapter_is_hidden(self):
        ok, calls = await self.run_check(999999, None, info_status=400)
        self.assertFalse(ok)
        self.assertEqual([m for m, _u in calls], ["GET"])
        for info in (None, {}, {"seriesId": "2"}, {"seriesId": True}, [1]):
            ok, _calls = await self.run_check(500, None, info=info)
            self.assertFalse(ok, info)

    async def test_refused_and_unreachable_are_errors_not_answers(self):
        from app.integrations import kavita
        with self.assertRaises(kavita.KavitaTokenRefused):
            await self.run_check(500, None, info_status=401)
        with self.assertRaises(kavita.KavitaUnavailable):
            await self.run_check(500, None, info_status=503)
        with self.assertRaises(kavita.KavitaTokenRefused):
            await self.run_check(136, 2, list_status=401)


if __name__ == "__main__":
    unittest.main()
