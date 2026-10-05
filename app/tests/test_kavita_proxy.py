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
        # The redirect check reads Authentik's address from the settings table: this test's own database,
        # not the app's (which has no tables outside the dev container).
        db_patch = mock.patch.object(kavita_proxy, "SessionLocal", self.Session)
        db_patch.start()
        self.addCleanup(db_patch.stop)
        helpers.set_rate_limits(False)

    def tearDown(self):
        self.helpers.reset_overrides()
        self.setup_patch.stop()
        self.helpers.set_rate_limits(True)

    def connect(self, fake):
        client = self.helpers.api_client(self.Session, self.helpers.MEMBER, headers=self.helpers.SAME_ORIGIN)
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
        client = self.helpers.api_client(self.Session, self.helpers.MEMBER, headers=self.helpers.SAME_ORIGIN)
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
        # As in ConnectFailureLandsOnBooks: the redirect check reads this test's database.
        db_patch = mock.patch.object(kavita_proxy, "SessionLocal", self.Session)
        db_patch.start()
        self.addCleanup(db_patch.stop)
        helpers.set_rate_limits(False)
        self.callback_client = TestClient(app)
        self.callback_client.cookies.set(settings.session_cookie_name, "test-session")
        self.cookie = settings.session_cookie_name

    def tearDown(self):
        self.helpers.reset_overrides()
        self.setup_patch.stop()
        self.helpers.set_rate_limits(True)

    def start(self, fake, query):
        client = self.helpers.api_client(self.Session, self.helpers.MEMBER, headers=self.helpers.SAME_ORIGIN)
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
        self.client = helpers.api_client(self.Session, user, headers=helpers.SAME_ORIGIN)

    def tearDown(self):
        self.helpers.reset_overrides()
        self.setup_patch.stop()
        self.helpers.set_rate_limits(True)

    def fetch(self, path, visible=True, catalog=None, raises=None):
        check = mock.AsyncMock(return_value=visible, side_effect=raises)
        with mock.patch.object(kavita_proxy, "kavita_url_for", return_value=KAVITA), \
             mock.patch.object(kavita_proxy.kavita_api, "items_are_visible", check), \
             mock.patch.object(kavita_proxy, "_catalog_series_of", return_value=catalog), \
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
                self.check.assert_awaited_once_with(KAVITA, "jwt-sam", [("chapter", 136, 104)])

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
        self.check.assert_awaited_once_with(KAVITA, "jwt-sam", [("chapter", 999999, None)])
        self.assertEqual(_RecordingProxyClient.asked, [])

    def test_kavita_refusing_the_token_is_401_and_not_answering_is_503(self):
        r = self.fetch("api/Book/136/book-info", raises=kavita_proxy.kavita_api.KavitaTokenRefused("expired"))
        self.assertEqual(r.status_code, 401)
        r = self.fetch("api/Book/136/book-info", raises=kavita_proxy.kavita_api.KavitaUnavailable("down"))
        self.assertEqual(r.status_code, 503)
        self.assertEqual(_RecordingProxyClient.asked, [])

    def test_a_request_that_names_nothing_is_not_asked_about(self):
        for path in ("api/Series/all-v2?PageNumber=1", "api/Series/series-detail", "api/search/search?queryString=x"):
            with self.subTest(path=path):
                r = self.fetch(path)
                self.assertEqual(r.status_code, 200)
                self.check.assert_not_awaited()

    def test_other_ids_are_asked_about_too(self):
        # (every path, in ScopedPaths)
        r = self.fetch("api/Reader/get-progress?chapterId=136", visible=False, catalog=104)
        self.assertEqual(r.status_code, 404)
        self.check.assert_awaited_once_with(KAVITA, "jwt-sam", [("chapter", 136, 104)])

    def test_nothing_is_remembered_between_requests(self):
        self.fetch("api/Book/136/book-info", visible=True)
        self.fetch("api/Book/136/book-info", visible=False)
        self.assertEqual(self.check.await_count, 1)         # asked again, answered fresh
        self.assertEqual(self.fetch("api/Book/136/book-info", visible=False).status_code, 404)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ScopedItems(unittest.TestCase):
    """FR4: what a proxied request names (chapter, volume or series ids in the
    path, the query or a JSON body), read the way Kavita reads them."""

    def items(self, path, query="", body=None, content_type="application/json"):
        from urllib.parse import parse_qsl
        raw = b"" if body is None else (body if isinstance(body, bytes) else __import__("json").dumps(body).encode())
        return kavita_proxy.scoped_items(path, parse_qsl(query, keep_blank_values=True), raw, content_type)

    def test_ids_in_the_path(self):
        self.assertEqual(self.items("api/Book/136/book-info"), {("chapter", 136)})
        self.assertEqual(self.items("api/book/136/book-resources", "file=a.png"), {("chapter", 136)})
        self.assertEqual(self.items("api/Series/104"), {("series", 104)})
        self.assertEqual(self.items("api/Download/volume/134"), {("volume", 134)})

    def test_ids_in_the_query_in_any_case_and_more_than_once(self):
        self.assertEqual(self.items("api/Series/chapter", "chapterId=135"), {("chapter", 135)})
        self.assertEqual(self.items("api/Series/chapter", "CHAPTERID=135"), {("chapter", 135)})
        self.assertEqual(self.items("api/image/volume-cover", "volumeid=7&apiKey=k"), {("volume", 7)})
        self.assertEqual(self.items("api/Series/metadata", "seriesId=1&seriesId=2"), {("series", 1), ("series", 2)})

    def test_ids_in_a_json_body(self):
        body = {"libraryId": 1, "seriesId": 104, "volumeId": 134, "chapterId": 135, "pageNum": 3}
        self.assertEqual(self.items("api/Reader/progress", body=body), {("series", 104), ("volume", 134), ("chapter", 135)})
        self.assertEqual(self.items("api/Series/series-by-ids", body={"seriesIds": [1, 2, "3"]}),
                         {("series", 1), ("series", 2), ("series", 3)})
        self.assertEqual(self.items("api/Reader/mark-multiple-read", body={"volumeIds": [5], "chapterIds": [6]}),
                         {("volume", 5), ("chapter", 6)})

    def test_a_request_about_nothing_in_particular_names_nothing(self):
        self.assertEqual(self.items("api/Series/all-v2", "PageNumber=1&PageSize=50", body={"statements": []}), set())
        self.assertEqual(self.items("api/Series/series-detail"), set())
        self.assertEqual(self.items("api/Reader/progress", body=b"not json"), set())
        self.assertEqual(self.items("api/Reader/progress", body={"seriesId": 5}, content_type="text/plain"), set())

    def test_an_id_that_is_not_a_plain_id_refuses_the_request(self):
        for query in ("chapterId=abc", "chapterId=", "chapterId=-1", "chapterId=0", "chapterId=1.5", "seriesId=99999999999",
                      "volumeId=1e3", "chapterId=0x10", "seriesId=%201"):
            with self.subTest(query=query):
                self.assertIsNone(self.items("api/Series/chapter", query))
        for body in ({"seriesId": "abc"}, {"chapterId": True}, {"seriesIds": "1"}, {"seriesIds": [1, None]},
                     {"chapterId": [1]}, {"volumeId": 0}):
            with self.subTest(body=body):
                self.assertIsNone(self.items("api/Reader/progress", body=body))

    def test_a_number_in_the_path_that_cannot_be_placed_refuses_the_request(self):
        for path in ("api/Reader/5", "api/image/9/cover", "api/Series/series-detail/5", "api/metadata/genres/3",
                     "api/Book/99999999999/book-info"):
            with self.subTest(path=path):
                self.assertIsNone(self.items(path))

    def test_naming_too_much_is_refused(self):
        self.assertIsNotNone(self.items("api/Series/series-by-ids", body={"seriesIds": list(range(1, 201))}))
        self.assertIsNone(self.items("api/Series/series-by-ids", body={"seriesIds": list(range(1, 202))}))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ScopedPaths(unittest.TestCase):
    """FR4: every path the reader and the Books pages use, and every one the
    proxy admits that takes a chapter, volume or series, is served for a
    visible item, 404 for a hidden one and 404 for one nobody knows; nothing
    is forwarded unless it is the person's to see."""

    GET = [
        ("api/Book/136/book-info", "", "chapter"), ("api/Book/136/book-page", "page=2", "chapter"),
        ("api/Book/136/chapters", "", "chapter"), ("api/Book/136/book-resources", "file=a.png", "chapter"),
        ("api/Series/series-detail", "seriesId=104", "series"), ("api/Series/104", "", "series"),
        ("api/Series/metadata", "seriesId=104", "series"), ("api/Series/related", "seriesId=104", "series"),
        ("api/Series/volume", "volumeId=134", "volume"), ("api/Series/chapter", "chapterId=135", "chapter"),
        ("api/Series/chapter-metadata", "chapterId=135", "chapter"),
        ("api/image/chapter-cover", "chapterId=135", "chapter"), ("api/image/volume-cover", "volumeId=134", "volume"),
        ("api/image/series-cover", "seriesId=104", "series"),
        ("api/download/chapter", "chapterId=135", "chapter"), ("api/download/volume", "volumeId=134", "volume"),
        ("api/download/series", "seriesId=104", "series"),
        ("api/Reader/get-progress", "chapterId=135", "chapter"), ("api/Reader/chapter-info", "chapterId=135", "chapter"),
        ("api/Reader/continue-point", "seriesId=104", "series"), ("api/Reader/image", "chapterId=135&page=1", "chapter"),
        ("api/Series/chapter", "ChapterId=135", "chapter"),
    ]
    POST = [
        ("api/Reader/progress", {"libraryId": 1, "seriesId": 104, "volumeId": 134, "chapterId": 135, "pageNum": 2},
         {("series", 104), ("volume", 134), ("chapter", 135)}),
        ("api/Reader/bookmark", {"seriesId": 104, "volumeId": 134, "chapterId": 135, "page": 3},
         {("series", 104), ("volume", 134), ("chapter", 135)}),
        ("api/Series/series-by-ids", {"seriesIds": [104, 105]}, {("series", 104), ("series", 105)}),
    ]

    def setUp(self):
        from app.tests import helpers
        self.helpers = helpers
        self.Session = helpers.make_sessionmaker()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        helpers.set_rate_limits(False)
        _RecordingProxyClient.asked = []
        user = dict(helpers.MEMBER, kavita_token="jwt-sam", kavita_base=KAVITA)
        self.client = helpers.api_client(self.Session, user, headers=helpers.SAME_ORIGIN)

    def tearDown(self):
        self.helpers.reset_overrides()
        self.setup_patch.stop()
        self.helpers.set_rate_limits(True)

    def call(self, method, path, query="", body=None, visible=True):
        check = mock.AsyncMock(return_value=visible)
        url = "/kavita/" + path + ("?" + query if query else "")
        with mock.patch.object(kavita_proxy, "kavita_url_for", return_value=KAVITA), \
             mock.patch.object(kavita_proxy.kavita_api, "items_are_visible", check), \
             mock.patch.object(kavita_proxy, "_catalog_series_of", return_value=104), \
             mock.patch.object(kavita_proxy.httpx, "AsyncClient", _RecordingProxyClient):
            r = self.client.get(url) if method == "get" else self.client.post(url, json=body)
        self.check = check
        return r

    def test_a_visible_item_is_served_and_asked_about_once(self):
        for path, query, kind in self.GET:
            with self.subTest(path=path, query=query):
                _RecordingProxyClient.asked = []
                r = self.call("get", path, query, visible=True)
                self.assertEqual(r.status_code, 200)
                self.assertEqual(len(_RecordingProxyClient.asked), 1)
                (base, token, items), _kw = self.check.await_args
                self.assertEqual((base, token), (KAVITA, "jwt-sam"))
                self.assertEqual([k for k, _i, _s in items], [kind])
                self.assertTrue(all(known == 104 for _k, _i, known in items))

    def test_a_hidden_or_foreign_item_is_404_and_nothing_is_forwarded(self):
        for path, query, _kind in self.GET:
            with self.subTest(path=path, query=query):
                _RecordingProxyClient.asked = []
                r = self.call("get", path, query, visible=False)
                self.assertEqual(r.status_code, 404)
                self.assertEqual(_RecordingProxyClient.asked, [])

    def test_a_write_names_its_ids_in_the_body_and_every_one_must_be_visible(self):
        for path, body, kinds in self.POST:
            with self.subTest(path=path):
                _RecordingProxyClient.asked = []
                r = self.call("post", path, body=body, visible=True)
                self.assertEqual(r.status_code, 200)
                (_b, _t, items), _kw = self.check.await_args
                self.assertEqual({(k, i) for k, i, _s in items}, kinds)
                _RecordingProxyClient.asked = []
                r = self.call("post", path, body=body, visible=False)
                self.assertEqual(r.status_code, 404)
                self.assertEqual(_RecordingProxyClient.asked, [])

    def test_a_request_that_names_nothing_is_forwarded_without_a_question(self):
        for path, query in (("api/Series/all-v2", "PageNumber=1&PageSize=50"), ("api/Series/series-detail", ""),
                            ("api/search/search", "queryString=harry")):
            with self.subTest(path=path):
                r = self.call("get", path, query)
                self.assertEqual(r.status_code, 200)
                self.check.assert_not_awaited()

    def test_an_id_that_is_not_a_plain_number_is_refused_not_forwarded(self):
        for path, query in (("api/Series/chapter", "chapterId=abc"), ("api/Series/chapter", "chapterId=-1"),
                            ("api/Series/chapter", "chapterId=0"), ("api/image/series-cover", "seriesId=1&seriesId=x"),
                            ("api/Reader/5", ""), ("api/Series/series-detail/5", "")):
            with self.subTest(path=path, query=query):
                _RecordingProxyClient.asked = []
                r = self.call("get", path, query)
                self.assertEqual(r.status_code, 404)
                self.assertEqual(_RecordingProxyClient.asked, [])
                self.check.assert_not_awaited()

    def test_a_second_hidden_id_among_visible_ones_hides_the_request(self):
        r = self.call("get", "api/Series/metadata", "seriesId=104&seriesId=105", visible=False)
        self.assertEqual(r.status_code, 404)
        (_b, _t, items), _kw = self.check.await_args
        self.assertEqual({i for _k, i, _s in items}, {104, 105})

    def test_the_paths_outside_the_allowlist_are_still_refused_first(self):
        r = self.call("get", "api/account/login", "chapterId=1")
        self.assertEqual(r.status_code, 404)
        self.check.assert_not_awaited()


def _literal_path_client(app):
    """A TestClient whose request path reaches the app exactly as the
    X-Literal-Path header spells it. httpx collapses a literal `..` before
    sending, while a real client, and the tunnel in front of the site, forward
    it as is. It sends the site's own Origin, as a browser on the site would."""
    from fastapi.testclient import TestClient

    from app.tests.helpers import SAME_ORIGIN

    async def literal(scope, receive, send):
        if scope["type"] == "http":
            for name, value in scope["headers"]:
                if name == b"x-literal-path":
                    scope = dict(scope, path=value.decode(), raw_path=value)
        await app(scope, receive, send)

    return TestClient(literal, headers=SAME_ORIGIN)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class DotSegments(unittest.TestCase):
    """F1: the allowlist and the visibility check read the path as received,
    while httpx (and Kavita) collapse `.` and `..` segments. `api/book/..` in
    front of any path would pass the checks as `book` and reach that path. A
    path with a dot segment in any spelling is refused before anything is
    asked of Kavita, and what is sent is exactly the path that was checked."""

    # Each is the path as the route receives it: uvicorn decodes the wire form
    # once, so a literal `..` and `%2e%2e` on the wire both arrive as `..`, and
    # a double-encoded `%252e%252e` arrives as `%2e%2e`, which Kavita decodes.
    TRAVERSALS = [
        "api/book/../Server/settings",               # the audit's hops
        "api/book/../account/login",
        "api/Book/136/../../account/login",
        "api/book/./136/book-info",                  # a single dot is refused too
        "api/book/136/..",
        "api/book/%2e%2e/account/login",
        "api/Book/%2E%2E/account/login",
        "api/book/.%2e/account/login",
        "api/book/%2e./account/login",
        "api/book/%252e%252e/account/login",
        "api/book/%2e/136/book-info",
        "api/book/..%2faccount/login",               # an encoded separator after the dots
        "api/book/..\\account/login",                # a backslash, read as / by some servers
        "api/book\\..\\account\\login",
        "api/book/%5c..%5caccount/login",
    ]

    def setUp(self):
        from app.tests import helpers
        self.helpers = helpers
        self.Session = helpers.make_sessionmaker()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        helpers.set_rate_limits(False)
        _RecordingProxyClient.asked = []
        self.check = mock.AsyncMock(return_value=True)
        self.patches = [
            mock.patch.object(kavita_proxy, "kavita_url_for", return_value=KAVITA),
            mock.patch.object(kavita_proxy.kavita_api, "items_are_visible", self.check),
            mock.patch.object(kavita_proxy, "_catalog_series_of", return_value=104),
            mock.patch.object(kavita_proxy.httpx, "AsyncClient", _RecordingProxyClient),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.helpers.reset_overrides()
        self.setup_patch.stop()
        self.helpers.set_rate_limits(True)

    def client_for(self, token):
        user = dict(self.helpers.MEMBER, kavita_token=token, kavita_base=KAVITA) if token else self.helpers.MEMBER
        return self.helpers.api_client(self.Session, user, headers=self.helpers.SAME_ORIGIN)

    def test_every_spelling_of_a_dot_segment_is_404_and_nothing_is_forwarded(self):
        from app.main import app
        for token in ("jwt-sam", None):
            self.client_for(token)
            client = _literal_path_client(app)
            for path in self.TRAVERSALS:
                for method in ("get", "post"):
                    with self.subTest(path=path, method=method, token=bool(token)):
                        _RecordingProxyClient.asked = []
                        r = client.request(method, "/kavita/placeholder",
                                           headers={"X-Literal-Path": "/kavita/" + path})
                        self.assertEqual(r.status_code, 404)
                        self.assertEqual(_RecordingProxyClient.asked, [])
                        self.check.assert_not_awaited()

    def test_an_encoded_dot_segment_from_a_browser_is_404(self):
        # The form the tunnel's edge would otherwise normalise: sent encoded.
        client = self.client_for("jwt-sam")
        for path in ("api/book/%2e%2e/Server/settings", "api/book/%2E%2E/account/login",
                     "api/book/..%2Faccount/login"):
            with self.subTest(path=path):
                _RecordingProxyClient.asked = []
                self.assertEqual(client.get("/kavita/" + path).status_code, 404)
                self.assertEqual(_RecordingProxyClient.asked, [])
                self.check.assert_not_awaited()

    def test_a_path_httpx_would_send_differently_is_404(self):
        # "%41" (from %2541 on the wire) would go out as an escape that Kavita
        # reads as "A": not the path that was checked.
        from app.main import app
        self.client_for("jwt-sam")
        r = _literal_path_client(app).get("/kavita/placeholder",
                                          headers={"X-Literal-Path": "/kavita/api/Series/%41ll-v2"})
        self.assertEqual(r.status_code, 404)
        self.assertEqual(_RecordingProxyClient.asked, [])

    def test_the_path_sent_is_exactly_the_path_checked(self):
        client = self.client_for("jwt-sam")
        for path in ("api/Series/all-v2", "api/Book/136/book-info", "api/image/series-cover"):
            with self.subTest(path=path):
                _RecordingProxyClient.asked = []
                r = client.get("/kavita/" + path)
                self.assertEqual(r.status_code, 200)
                self.assertEqual([str(url) for url in _RecordingProxyClient.asked], [KAVITA + "/" + path])


class _FakeRedis:
    """Just the two calls the shortcut makes, with a clock the test moves."""
    def __init__(self):
        self.now = 0
        self.kept = {}
        self.sets = []

    async def exists(self, key):
        return 1 if key in self.kept and self.kept[key] > self.now else 0

    async def set(self, key, value, ex=None):
        self.sets.append((key, ex))
        self.kept[key] = self.now + ex


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ChapterShortcut(unittest.TestCase):
    """T4P1: a chapter found allowed is remembered in Redis for ten minutes,
    per session, so a page turn does not cost a Kavita call each time."""

    def setUp(self):
        from app.config import settings
        from app.tests import helpers
        self.helpers = helpers
        self.cookie = settings.session_cookie_name
        self.Session = helpers.make_sessionmaker()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        helpers.set_rate_limits(False)
        _RecordingProxyClient.asked = []
        self.redis = _FakeRedis()
        self.visible = True
        self.check = mock.AsyncMock(side_effect=lambda *a: self.visible)

    def tearDown(self):
        self.helpers.reset_overrides()
        self.setup_patch.stop()
        self.helpers.set_rate_limits(True)

    def fetch(self, session="sid-1", token="jwt-sam", chapter=136, redis="fake", raises=None):
        user = dict(self.helpers.MEMBER, kavita_token=token, kavita_base=KAVITA)
        client = self.helpers.api_client(self.Session, user, headers=self.helpers.SAME_ORIGIN)
        client.cookies.set(self.cookie, session)
        sm = kavita_proxy.session_manager
        if redis == "fake":
            get_redis = mock.AsyncMock(return_value=self.redis)
        else:
            get_redis = mock.AsyncMock(side_effect=raises or OSError("redis is down"))
        if raises is not None:
            self.check.side_effect = raises
        with mock.patch.object(kavita_proxy, "kavita_url_for", return_value=KAVITA), \
             mock.patch.object(sm, "get_redis", get_redis), \
             mock.patch.object(kavita_proxy.kavita_api, "items_are_visible", self.check), \
             mock.patch.object(kavita_proxy, "_catalog_series_of", return_value=104), \
             mock.patch.object(kavita_proxy.httpx, "AsyncClient", _RecordingProxyClient):
            return client.get(f"/kavita/api/Book/{chapter}/book-page?page=1")

    def test_the_second_request_skips_the_kavita_call(self):
        self.assertEqual(self.fetch().status_code, 200)
        self.assertEqual(self.check.await_count, 1)
        self.assertEqual(self.fetch().status_code, 200)
        self.assertEqual(self.fetch().status_code, 200)
        self.assertEqual(self.check.await_count, 1)                       # a hit skipped it twice
        self.assertEqual(len(_RecordingProxyClient.asked), 3)             # and every page was served
        self.assertEqual([ttl for _k, ttl in self.redis.sets], [600])

    def test_after_ten_minutes_it_is_asked_again(self):
        self.fetch()
        self.redis.now += 599
        self.fetch()
        self.assertEqual(self.check.await_count, 1)
        self.redis.now += 2
        self.fetch()
        self.assertEqual(self.check.await_count, 2)
        self.fetch()
        self.assertEqual(self.check.await_count, 2)                       # and kept again

    def test_another_session_is_not_covered_by_this_ones_entry(self):
        self.fetch(session="sid-1")
        self.fetch(session="sid-2")
        self.assertEqual(self.check.await_count, 2)
        self.fetch(session="sid-2")
        self.assertEqual(self.check.await_count, 2)
        keys = {k for k, _ttl in self.redis.sets}
        self.assertEqual(len(keys), 2)

    def test_another_chapter_and_a_new_sign_in_are_asked(self):
        self.fetch()
        self.fetch(chapter=137)
        self.assertEqual(self.check.await_count, 2)
        self.fetch(token="jwt-sam-new")                                   # reconnected: a new token, a new entry
        self.assertEqual(self.check.await_count, 3)
        self.assertNotIn("jwt-sam", " ".join(k for k, _ttl in self.redis.sets))    # the token itself is never a key

    def test_only_allowed_is_kept(self):
        self.visible = False
        for _ in range(3):
            self.assertEqual(self.fetch().status_code, 404)
        self.assertEqual(self.check.await_count, 3)
        self.assertEqual(self.redis.sets, [])
        for failure in (kavita_proxy.kavita_api.KavitaTokenRefused("x"), kavita_proxy.kavita_api.KavitaUnavailable("x")):
            self.fetch(raises=failure)
            self.fetch(raises=failure)
        self.assertEqual(self.check.await_count, 7)
        self.assertEqual(self.redis.sets, [])
        self.assertEqual(_RecordingProxyClient.asked, [])

    def test_with_redis_down_every_request_runs_the_check(self):
        for _ in range(3):
            self.assertEqual(self.fetch(redis="down").status_code, 200)
        self.assertEqual(self.check.await_count, 3)
        self.visible = False
        self.assertEqual(self.fetch(redis="down").status_code, 404)       # and a hidden chapter is still hidden

    def test_with_a_redis_that_fails_on_reading_or_writing_the_check_still_runs(self):
        class Broken(_FakeRedis):
            async def exists(self, key):
                raise OSError("read failed")

            async def set(self, key, value, ex=None):
                raise OSError("write failed")
        self.redis = Broken()
        self.assertEqual(self.fetch().status_code, 200)
        self.assertEqual(self.fetch().status_code, 200)
        self.assertEqual(self.check.await_count, 2)

    def test_no_session_cookie_no_shortcut(self):
        user = dict(self.helpers.MEMBER, kavita_token="jwt", kavita_base=KAVITA)
        client = self.helpers.api_client(self.Session, user, headers=self.helpers.SAME_ORIGIN)
        with mock.patch.object(kavita_proxy, "kavita_url_for", return_value=KAVITA), \
             mock.patch.object(kavita_proxy.session_manager, "get_redis", mock.AsyncMock(return_value=self.redis)), \
             mock.patch.object(kavita_proxy.kavita_api, "items_are_visible", self.check), \
             mock.patch.object(kavita_proxy, "_catalog_series_of", return_value=104), \
             mock.patch.object(kavita_proxy.httpx, "AsyncClient", _RecordingProxyClient):
            client.get("/kavita/api/Book/136/book-page?page=1")
            client.get("/kavita/api/Book/136/book-page?page=1")
        self.assertEqual(self.check.await_count, 2)
        self.assertEqual(self.redis.sets, [])

    def test_nothing_is_held_in_the_process(self):
        import inspect
        src = inspect.getsource(kavita_proxy._require_visible_items)
        self.assertNotRegex(src, r"\bglobal\b")
        self.assertNotRegex(inspect.getsource(kavita_proxy), r"(?m)^_item_ok\w*\s*[:=]\s*(\{|dict\()")


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

    async def items(self, items, **kwargs):
        from app.integrations import kavita
        fake, calls = self.client(**kwargs)
        with mock.patch.object(kavita, "_user_client", return_value=fake):
            return await kavita.items_are_visible(KAVITA, "jwt", items), calls

    async def test_a_volume_names_its_series_in_its_own_answer(self):
        ok, calls = await self.items([("volume", 134, None)], info={"id": 134, "seriesId": 2})
        self.assertTrue(ok)
        self.assertEqual([m for m, _u in calls], ["GET", "POST"])
        self.assertIn("/api/Series/volume", calls[0][1])
        ok, _calls = await self.items([("volume", 134, None)], info={"id": 134, "seriesId": 77})
        self.assertFalse(ok)
        ok, _calls = await self.items([("volume", 99999999, None)], info_status=404)
        self.assertFalse(ok)

    async def test_a_series_is_its_own_and_costs_only_the_list(self):
        ok, calls = await self.items([("series", 2, None)])
        self.assertTrue(ok)
        self.assertEqual([m for m, _u in calls], ["POST"])
        ok, _calls = await self.items([("series", 77, None)])
        self.assertFalse(ok)

    async def test_several_items_read_the_list_once_and_all_must_be_visible(self):
        ok, calls = await self.items([("series", 1, None), ("chapter", 5, None), ("volume", 6, 1)], info={"seriesId": 1})
        self.assertTrue(ok)
        self.assertEqual([m for m, _u in calls], ["GET", "POST"])
        ok, _calls = await self.items([("series", 1, None), ("chapter", 5, 77)])
        self.assertFalse(ok)
        ok, calls = await self.items([])
        self.assertTrue(ok)
        self.assertEqual(calls, [])

    async def test_refused_and_unreachable_are_errors_not_answers(self):
        from app.integrations import kavita
        with self.assertRaises(kavita.KavitaTokenRefused):
            await self.run_check(500, None, info_status=401)
        with self.assertRaises(kavita.KavitaUnavailable):
            await self.run_check(500, None, info_status=503)
        with self.assertRaises(kavita.KavitaTokenRefused):
            await self.run_check(136, 2, list_status=401)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ScanLibraries(unittest.IsolatedAsyncioTestCase):
    """FR3: Kavita is asked to scan through its admin API with the key's own
    account; the answer is only whether it was asked."""

    def fake(self, libraries=({"id": 1}, {"id": 2}), scan_status=200, token_status=200):
        calls = []

        class Resp:
            def __init__(self, status, body=None):
                self.status_code, self._body, self.headers = status, body, {}

            def json(self):
                return self._body

        class Client:
            def __init__(self, *a, **k):
                pass

            async def __aenter__(self_):
                return self_

            async def __aexit__(self_, *exc):
                return False

            async def post(self_, url, params=None, headers=None, **kw):
                calls.append(("POST", url.replace(KAVITA, ""), dict(params or {}), bool(headers)))
                if "Plugin/authenticate" in url:
                    return Resp(token_status, {"token": "admin-jwt"})
                return Resp(scan_status)

            async def request(self_, method, url, headers=None, **kw):
                calls.append((method, url.replace(KAVITA, ""), {}, bool(headers)))
                return Resp(200, list(libraries) if libraries is not None else None)
        return Client, calls

    async def run_scan(self, **kwargs):
        from app.integrations import kavita
        Client, calls = self.fake(**kwargs)
        with mock.patch.object(kavita, "_config", return_value=(KAVITA, "key")), \
             mock.patch.object(kavita.httpx, "AsyncClient", Client):
            return await kavita.scan_libraries(), calls

    async def test_every_library_is_asked_once_without_forcing(self):
        asked, calls = await self.run_scan()
        self.assertEqual(asked, 2)
        scans = [c for c in calls if c[1] == "/api/Library/scan"]
        self.assertEqual([c[2] for c in scans], [{"libraryId": 1, "force": "false"}, {"libraryId": 2, "force": "false"}])
        self.assertTrue(all(c[0] == "POST" and c[3] for c in scans))           # with the admin's token

    async def test_the_number_of_libraries_asked_is_capped(self):
        asked, calls = await self.run_scan(libraries=[{"id": i} for i in range(1, 60)])
        self.assertEqual(asked, 20)

    async def test_odd_library_lists_ask_for_nothing(self):
        for libraries in ([], None, [{"name": "x"}, {"id": "1"}, 5]):
            asked, calls = await self.run_scan(libraries=libraries)
            self.assertEqual(asked, 0)
            self.assertEqual([c for c in calls if c[1] == "/api/Library/scan"], [])

    async def test_refusals_and_failures_are_fixed_sentences(self):
        from app.integrations import kavita
        for status, text in ((401, "not an admin"), (403, "not an admin"), (500, "HTTP 500"), (404, "HTTP 404")):
            with self.assertRaises(kavita.KavitaUnavailable) as caught:
                await self.run_scan(scan_status=status)
            self.assertIn(text, str(caught.exception))
            self.assertNotIn("key", str(caught.exception).replace("the key's account", ""))
            self.assertNotIn(KAVITA, str(caught.exception))
        with self.assertRaises(kavita.KavitaUnavailable):
            await self.run_scan(token_status=401)


if __name__ == "__main__":
    unittest.main()
