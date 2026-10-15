"""
A signed-in person is never sent to the identity provider's login page just to
open Books.

Each person's Kavita API key is kept server-side (services/kavita_keys.py, the
kavita_keys table) after a successful hand-off, and a session with no Kavita
sign-in for the current address, or one Kavita refuses, is given a new token
from it with no browser trip: where the Books page is served (connect_first),
where the Books API reads the person's series (books._kavita_reach) and in the
Kavita proxy (its 401 renews once and retries once). Only a person with no key
for this address, or one Kavita refuses (the key is then deleted), takes the
trip.

The trip itself, when nobody asked for it, asks the identity provider with
prompt=none, so a lapsed session there ends at /signin-oidc as login_required
and the page's own connect box; the Connect / Try again click adds
interactive=1 and leaves it off.

Everything runs against an in-memory database and mocked Kavita answers.
"""
import asyncio
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlparse

try:
    import httpx
    from fastapi import HTTPException
    from fastapi.testclient import TestClient

    from app.auth import session_manager
    from app.config import settings
    from app.integrations import kavita
    from app.main import app
    from app.models import KavitaKey
    from app.routers import books, kavita_proxy
    from app.services import kavita_keys
    from app.tests import helpers
    from app.tests.test_kavita_proxy import _FakeKavita, _FakeResponse
    from app.tests.test_settings_gate import MEMBER_SID, SettingsGateBase
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False
    SettingsGateBase = unittest.TestCase

KAVITA = "http://kavita.test:5000"
ELSEWHERE = "http://elsewhere.test:5000"
AUTHENTIK = "https://auth.example.com"
IDENTITY = "plex:4242"
KEY = "SYNTH-PERSON-KEY-1"
FRESH = "SYNTH-FRESH-JWT"


def person(**fields):
    """A signed-in member whose account identity is plex:4242."""
    return dict(helpers.MEMBER, user_id="4242", plex_account_id="4242", **fields)


class KeysBase(unittest.TestCase):
    """An in-memory database for the key table, Kavita's exchange mocked."""

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.addCleanup(self.db.close)
        self.update = mock.AsyncMock()
        self.mint = mock.AsyncMock(return_value=FRESH)
        for patch in (mock.patch.object(kavita_keys, "SessionLocal", self.Session),
                      mock.patch.object(kavita_proxy, "SessionLocal", self.Session),
                      mock.patch.object(session_manager, "update_session", self.update),
                      mock.patch.object(kavita, "person_token", self.mint)):
            patch.start()
            self.addCleanup(patch.stop)

    def store(self, base=KAVITA, key=KEY, identity=IDENTITY):
        from app.services.insights_store import now_utc
        self.db.merge(KavitaKey(identity=identity, base=base, api_key=key, stored_at=now_utc()))
        self.db.commit()

    def row(self, identity=IDENTITY):
        self.db.expire_all()
        return self.db.query(KavitaKey).filter(KavitaKey.identity == identity).first()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Relink(KeysBase):
    def relink(self, user, base=KAVITA, session_id="sid-1"):
        return asyncio.run(kavita_keys.relink(user, base, session_id))

    def test_a_session_without_a_token_is_signed_in_from_the_kept_key(self):
        self.store()
        user = person()
        got = self.relink(user)
        self.assertEqual(got, (FRESH, KEY))
        self.mint.assert_awaited_once_with(KAVITA, KEY)
        fields = {"kavita_token": FRESH, "kavita_api_key": KEY, "kavita_base": KAVITA}
        self.update.assert_awaited_once_with("sid-1", fields)
        self.assertEqual({k: user[k] for k in fields}, fields)       # the rest of the request sees it

    def test_a_key_kavita_refuses_is_deleted_and_nothing_is_signed_in(self):
        self.store()
        self.mint.side_effect = kavita.KavitaTokenRefused("rotated")
        self.assertIsNone(self.relink(person()))
        self.assertIsNone(self.row())
        self.update.assert_not_awaited()

    def test_a_key_kept_for_another_address_is_never_used(self):
        self.store(base=ELSEWHERE)
        self.assertIsNone(self.relink(person()))
        self.mint.assert_not_awaited()
        self.assertIsNotNone(self.row())                              # not this address's to judge

    def test_the_session_key_from_another_address_is_never_used(self):
        user = person(kavita_api_key=KEY, kavita_base=ELSEWHERE)
        self.assertIsNone(self.relink(user))
        self.mint.assert_not_awaited()

    def test_the_same_address_respelled_is_the_same_address(self):
        self.store(base=KAVITA + "/")
        self.assertEqual(self.relink(person()).token, FRESH)

    def test_kavita_not_answering_keeps_the_key_and_says_so(self):
        self.store()
        self.mint.side_effect = kavita.KavitaUnavailable("down")
        with self.assertRaises(kavita.KavitaUnavailable):
            self.relink(person())
        self.assertIsNotNone(self.row())

    def test_no_session_to_save_it_in_asks_nothing(self):
        self.store()
        self.assertIsNone(self.relink(person(), session_id=None))
        self.mint.assert_not_awaited()

    def test_no_identity_and_no_session_key_asks_nothing(self):
        self.store()
        self.assertIsNone(self.relink(dict(helpers.MEMBER)))
        self.mint.assert_not_awaited()

    def test_the_kept_key_wins_over_an_older_one_in_the_session(self):
        self.store(key="SYNTH-NEWER-KEY")
        self.relink(person(kavita_api_key=KEY, kavita_base=KAVITA))
        self.mint.assert_awaited_once_with(KAVITA, "SYNTH-NEWER-KEY")

    def test_a_session_from_before_keys_were_kept_gives_its_key_to_the_table(self):
        self.relink(person(kavita_api_key=KEY, kavita_base=KAVITA))
        self.assertEqual((self.row().base, self.row().api_key), (KAVITA, KEY))

    def test_remember_replaces_the_key_and_needs_an_identity(self):
        kavita_keys.remember(person(), KAVITA, "SYNTH-OLD")
        kavita_keys.remember(person(), ELSEWHERE, KEY)
        self.assertEqual((self.row().base, self.row().api_key), (ELSEWHERE, KEY))
        kavita_keys.remember(dict(helpers.MEMBER), KAVITA, KEY)
        self.assertEqual(self.db.query(KavitaKey).count(), 1)

    def test_a_database_failure_is_not_a_key(self):
        self.store()
        with mock.patch.object(kavita_keys, "SessionLocal", side_effect=lambda: self.broken()):
            self.assertIsNone(self.relink(person()))
        self.mint.assert_not_awaited()

    def broken(self):
        from sqlalchemy.exc import OperationalError
        session = mock.MagicMock()
        session.query.side_effect = OperationalError("select", {}, Exception("no such table"))
        return session


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class BooksReach(KeysBase):
    """books._kavita_reach: what the Books API does for a session with no token."""

    def setUp(self):
        super().setUp()
        self.series = mock.AsyncMock(return_value={1, 2})
        self.url = mock.Mock(return_value=KAVITA)
        for patch in (mock.patch.object(kavita, "user_series_ids", self.series),
                      mock.patch.object(books.kavita_proxy, "kavita_url_for", self.url)):
            patch.start()
            self.addCleanup(patch.stop)

    def reach(self, user):
        return asyncio.run(books._kavita_reach(user, "sid-1"))

    def test_no_token_and_a_kept_key_loads_the_books_with_no_connect_note(self):
        self.store()
        series, reach, note = self.reach(person())
        self.assertEqual((series, reach, note), ({1, 2}, (KAVITA, FRESH), None))
        self.series.assert_awaited_once_with(KAVITA, FRESH)

    def test_a_token_from_another_address_is_replaced_not_sent(self):
        self.store()
        series, reach, note = self.reach(person(kavita_token="old", kavita_base=ELSEWHERE))
        self.assertEqual((reach, note), ((KAVITA, FRESH), None))
        self.series.assert_awaited_once_with(KAVITA, FRESH)

    def test_a_refused_kept_key_is_deleted_and_the_trip_is_asked_for(self):
        self.store()
        self.mint.side_effect = kavita.KavitaTokenRefused("rotated")
        _series, reach, note = self.reach(person())
        self.assertEqual((reach, note["reason"]), (None, "not_connected"))
        self.assertIsNone(self.row())

    def test_no_key_at_all_asks_for_the_trip(self):
        _series, reach, note = self.reach(person())
        self.assertEqual((reach, note["reason"]), (None, "not_connected"))
        self.mint.assert_not_awaited()

    def test_a_key_kept_for_another_address_is_not_used(self):
        self.store(base=ELSEWHERE)
        _series, reach, note = self.reach(person())
        self.assertEqual((reach, note["reason"]), (None, "not_connected"))
        self.mint.assert_not_awaited()

    def test_a_token_kavita_refuses_is_renewed_from_the_kept_key_once(self):
        self.store()
        self.series.side_effect = [kavita.KavitaTokenRefused("expired"), {3}]
        series, reach, _note = self.reach(person(kavita_token="old", kavita_base=KAVITA))
        self.assertEqual((series, reach), ({3}, (KAVITA, FRESH)))
        self.mint.assert_awaited_once_with(KAVITA, KEY)

    def test_a_freshly_minted_token_kavita_refuses_is_not_minted_again(self):
        self.store()
        self.series.side_effect = kavita.KavitaTokenRefused("odd")
        _series, reach, note = self.reach(person())
        self.assertEqual((reach, note["reason"]), (None, "not_connected"))
        self.mint.assert_awaited_once()

    def test_ebooks_off_for_a_member_mints_nothing(self):
        self.store()
        self.url.side_effect = HTTPException(status_code=403, detail="eBooks is turned off")
        self.assertEqual(self.reach(person()), (set(), None, None))
        self.mint.assert_not_awaited()


class _Upstream:
    """Kavita behind the proxy: answers by the token each request carries."""

    def __init__(self, good=(FRESH,)):
        self.good = set(good)
        self.seen = []

    def __call__(self, request):
        self.seen.append(request)
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        return httpx.Response(200 if token in self.good else 401, json=[])

    def tokens(self):
        return [r.headers.get("authorization", "") for r in self.seen]


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ProxyRenews(KeysBase):
    def setUp(self):
        super().setUp()
        helpers.set_rate_limits(False)
        self.addCleanup(helpers.set_rate_limits, True)
        patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        patch.start()
        self.addCleanup(patch.stop)
        helpers.put(self.db, "integration.kavita.url", KAVITA)
        self.upstream = _Upstream()

    def fetch(self, user, path="api/series/all", visible=None):
        client = helpers.api_client(self.Session, user, headers=helpers.SAME_ORIGIN)
        self.addCleanup(helpers.reset_overrides)
        client.cookies.set(settings.session_cookie_name, "sid-1")
        real = httpx.AsyncClient
        patches = [mock.patch.object(kavita_proxy.httpx, "AsyncClient",
                                     lambda **kw: real(transport=httpx.MockTransport(self.upstream), **kw))]
        if visible is not None:
            patches += [mock.patch.object(kavita_proxy.kavita_api, "items_are_visible", visible),
                        mock.patch.object(kavita_proxy, "_catalog_series_of", return_value=104)]
        for p in patches:
            p.start()
        try:
            return client.get("/kavita/" + path)
        finally:
            for p in patches:
                p.stop()

    def test_no_token_and_a_kept_key_is_signed_in_before_the_request_goes(self):
        self.store()
        r = self.fetch(person())
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.upstream.tokens(), ["Bearer " + FRESH])      # one request, already signed in
        self.mint.assert_awaited_once_with(KAVITA, KEY)
        self.update.assert_awaited_once_with(
            "sid-1", {"kavita_token": FRESH, "kavita_api_key": KEY, "kavita_base": KAVITA})

    def test_a_401_renews_from_the_kept_key_and_retries_once(self):
        self.store()
        r = self.fetch(person(kavita_token="expired", kavita_base=KAVITA))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.upstream.tokens(), ["Bearer expired", "Bearer " + FRESH])
        self.mint.assert_awaited_once()

    def test_the_retry_is_the_same_request_with_the_same_body(self):
        self.store()
        client = helpers.api_client(self.Session, person(kavita_token="expired", kavita_base=KAVITA),
                                    headers=helpers.SAME_ORIGIN)
        self.addCleanup(helpers.reset_overrides)
        client.cookies.set(settings.session_cookie_name, "sid-1")
        real = httpx.AsyncClient
        with mock.patch.object(kavita_proxy.httpx, "AsyncClient",
                               lambda **kw: real(transport=httpx.MockTransport(self.upstream), **kw)):
            r = client.post("/kavita/api/Search/search?queryString=dune", content=b'{"a": 1}',
                            headers={"content-type": "application/json"})
        self.assertEqual(r.status_code, 200, (r.text, self.upstream.tokens()))
        first, second = self.upstream.seen
        self.assertEqual((first.method, first.url.query, first.content), (second.method, second.url.query, second.content))
        self.assertEqual(second.content, b'{"a": 1}')

    def test_the_image_key_follows_the_renewal(self):
        self.store(key="SYNTH-IMAGE-KEY")
        r = self.fetch(person(kavita_token="expired", kavita_base=KAVITA, kavita_api_key="SYNTH-OLD-KEY"),
                       path="api/image/series-cover?seriesId=1", visible=mock.AsyncMock(return_value=True))
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("SYNTH-OLD-KEY", str(self.upstream.seen[-1].url))
        self.assertIn("apiKey=SYNTH-IMAGE-KEY", str(self.upstream.seen[-1].url))

    def test_a_second_401_is_the_clients_to_handle_and_nothing_loops(self):
        self.store()
        self.upstream.good = set()
        r = self.fetch(person(kavita_token="expired", kavita_base=KAVITA))
        self.assertEqual(r.status_code, 401)
        self.assertEqual(len(self.upstream.seen), 2)
        self.mint.assert_awaited_once()

    def test_a_refused_kept_key_is_deleted_and_the_401_stands(self):
        self.store()
        self.mint.side_effect = kavita.KavitaTokenRefused("rotated")
        r = self.fetch(person(kavita_token="expired", kavita_base=KAVITA))
        self.assertEqual(r.status_code, 401)
        self.assertIsNone(self.row())
        self.assertEqual(len(self.upstream.seen), 1)

    def test_no_key_at_all_is_a_401_for_the_page_to_reconnect(self):
        r = self.fetch(person())
        self.assertEqual(r.status_code, 401)
        self.mint.assert_not_awaited()
        self.assertEqual(self.upstream.tokens(), [""])                    # nothing of anyone's was sent

    def test_a_key_kept_for_another_address_is_never_sent_to_this_one(self):
        self.store(base=ELSEWHERE)
        r = self.fetch(person(kavita_token="old", kavita_base=ELSEWHERE, kavita_api_key=KEY))
        self.assertEqual(r.status_code, 401)
        self.mint.assert_not_awaited()
        self.assertTrue(all(KEY not in str(q.url) and "old" not in q.headers.get("authorization", "")
                            for q in self.upstream.seen))

    def test_kavita_not_answering_while_renewing_is_a_503(self):
        self.store()
        self.mint.side_effect = kavita.KavitaUnavailable("down")
        r = self.fetch(person(kavita_token="expired", kavita_base=KAVITA))
        self.assertEqual(r.status_code, 503)
        self.assertIsNotNone(self.row())

    def test_ebooks_off_for_a_member_mints_nothing(self):
        self.store()
        helpers.put(self.db, "sidebar.enabled_library", "false")
        r = self.fetch(person())
        self.assertEqual(r.status_code, 403)
        self.mint.assert_not_awaited()
        self.assertEqual(self.upstream.seen, [])

    def test_the_visibility_check_refusing_the_token_renews_and_asks_again(self):
        self.store()
        visible = mock.AsyncMock(side_effect=[kavita.KavitaTokenRefused("expired"), True])
        r = self.fetch(person(kavita_token="expired", kavita_base=KAVITA), path="api/Series/104", visible=visible)
        self.assertEqual(r.status_code, 200)
        self.assertEqual([c.args[1] for c in visible.await_args_list], ["expired", FRESH])
        self.assertEqual(self.upstream.tokens(), ["Bearer " + FRESH])
        self.mint.assert_awaited_once()

    def test_the_visibility_check_refusing_a_renewed_token_is_a_401(self):
        self.store()
        visible = mock.AsyncMock(side_effect=kavita.KavitaTokenRefused("odd"))
        r = self.fetch(person(kavita_token="expired", kavita_base=KAVITA), path="api/Series/104", visible=visible)
        self.assertEqual(r.status_code, 401)
        self.assertEqual(visible.await_count, 2)
        self.mint.assert_awaited_once()
        self.assertEqual(self.upstream.seen, [])


class _AuthorizeKavita(_FakeKavita):
    """/oidc/login answers with Authentik's authorize address, as Kavita does."""

    async def get(self, *args, **kwargs):
        r = _FakeResponse({})
        r.headers = httpx.Headers({"location": AUTHENTIK + "/application/o/authorize/?client_id=x&state=y"
                                                          "&response_mode=form_post"})
        return r


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TripAsksWithoutAPrompt(KeysBase):
    """prompt=none on every trip nobody asked for, off for the click."""

    def setUp(self):
        super().setUp()
        helpers.set_rate_limits(False)
        self.addCleanup(helpers.set_rate_limits, True)
        patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        patch.start()
        self.addCleanup(patch.stop)
        helpers.put(self.db, "integration.authentik.url", AUTHENTIK)

    def trip(self, query):
        client = helpers.api_client(self.Session, person(), headers=helpers.SAME_ORIGIN)
        self.addCleanup(helpers.reset_overrides)
        client.cookies.set(settings.session_cookie_name, "sid-1")
        with mock.patch.object(kavita_proxy, "kavita_url_for", return_value=KAVITA), \
             mock.patch.object(kavita_proxy.httpx, "AsyncClient", _AuthorizeKavita):
            r = client.get("/kavita/connect" + query, follow_redirects=False)
        self.assertEqual(r.status_code, 302)
        target = urlparse(r.headers["location"])
        self.assertEqual(f"{target.scheme}://{target.netloc}", AUTHENTIK)
        return parse_qs(target.query)

    def test_an_automatic_trip_asks_with_prompt_none(self):
        for query in ("?return=%2Fbooks", "", "?return=%2Fbooks&interactive=0", "?interactive=true"):
            with self.subTest(query=query):
                params = self.trip(query)
                self.assertEqual(params["prompt"], ["none"])
                self.assertEqual(params["response_mode"], ["query"])      # the existing rewrite still happens
                self.assertEqual((params["client_id"], params["state"]), (["x"], ["y"]))

    def test_the_clicked_trip_leaves_it_off(self):
        params = self.trip("?return=%2Fbooks&interactive=1")
        self.assertNotIn("prompt", params)
        self.assertEqual(params["response_mode"], ["query"])

    def test_the_helper_replaces_a_prompt_already_there(self):
        out = kavita_proxy.with_prompt_none(AUTHENTIK + "/authorize/?prompt=login&state=y")
        self.assertEqual(parse_qs(urlparse(out).query), {"prompt": ["none"], "state": ["y"]})


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class CallbackEnds(KeysBase):
    """/signin-oidc: the end of the trip, with and without Authentik's login."""

    def setUp(self):
        super().setUp()
        helpers.set_rate_limits(False)
        self.addCleanup(helpers.set_rate_limits, True)
        patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        patch.start()
        self.addCleanup(patch.stop)
        self.client = TestClient(app, follow_redirects=False)
        self.client.cookies.set(settings.session_cookie_name, "sid-1")

    def callback(self, query="", session=None, cookies=".AspNetCore.Cookies=abc", fake=_FakeKavita):
        rows = {"integration.kavita.url": KAVITA, "sidebar.enabled_library": "true"}
        session = {**(session or person()), "kavita_return": "/books/7"}
        with mock.patch.object(session_manager, "get_session", mock.AsyncMock(return_value=session)), \
             mock.patch.object(kavita_proxy, "_read_settings",
                               side_effect=lambda *keys: {k: rows.get(k, "") for k in keys}), \
             mock.patch.object(kavita_proxy, "collect_cookies", return_value=cookies), \
             mock.patch.object(kavita_proxy.httpx, "AsyncClient",
                               mock.MagicMock(side_effect=lambda *a, **k: fake(*a, **k))) as client_class:
            r = self.client.get("/signin-oidc" + query)
        return r, client_class

    def test_login_required_ends_at_the_page_with_the_flag_and_asks_kavita_nothing(self):
        for error in ("login_required", "access_denied", "interaction_required"):
            with self.subTest(error=error):
                self.update.reset_mock()
                r, client_class = self.callback(f"?error={error}&state=abc")
                self.assertEqual((r.status_code, r.headers["location"]), (302, "/books/7?kavita=error"))
                client_class.assert_not_called()
                self.assertEqual(self.update.await_args.args[1], {"kavita_return": ""})   # the return is forgotten
                self.assertIsNone(self.row())

    def test_a_connect_keeps_the_key_for_the_next_session(self):
        r, _ = self.callback("?code=c&state=abc")
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/books/7"))
        self.assertEqual((self.row().base, self.row().api_key), (KAVITA, "key"))

    def test_a_connect_that_gets_no_token_keeps_nothing(self):
        r, _ = self.callback("?code=c&state=abc", cookies="")
        self.assertEqual(r.headers["location"], "/books/7?kavita=error")
        self.assertIsNone(self.row())

    def test_a_new_connect_replaces_a_rotated_key(self):
        self.store(key="SYNTH-ROTATED")
        self.callback("?code=c&state=abc")
        self.assertEqual(self.row().api_key, "key")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class PageServedSignedIn(SettingsGateBase):
    """connect_first: the Books page's own address, for a session with no Kavita sign-in."""

    def setUp(self):
        super().setUp()
        helpers.put(self.db, "integration.kavita.url", KAVITA)
        self.sessions = {MEMBER_SID: person()}

        async def get_session(session_id):
            return self.sessions.get(session_id)

        async def update(session_id, fields):
            if session_id in self.sessions:
                self.sessions[session_id].update(fields)

        self.mint = mock.AsyncMock(return_value=FRESH)
        for patch in (mock.patch.object(session_manager, "get_session", side_effect=get_session),
                      mock.patch.object(session_manager, "update_session", side_effect=update),
                      mock.patch.object(kavita_keys, "SessionLocal", self.Session),
                      mock.patch.object(kavita, "person_token", self.mint)):
            patch.start()
            self.addCleanup(patch.stop)

    def member(self):
        return self.client(MEMBER_SID)

    def assert_page(self, r, path):
        self.assertEqual(r.status_code, 200, path)
        self.assertIn('id="ws-data"', r.text, path)

    def store(self, base=KAVITA, key=KEY):
        from app.services.insights_store import now_utc
        self.db.merge(KavitaKey(identity=IDENTITY, base=base, api_key=key, stored_at=now_utc()))
        self.db.commit()

    def row(self):
        self.db.expire_all()
        return self.db.query(KavitaKey).filter(KavitaKey.identity == IDENTITY).first()

    def test_a_kept_key_serves_the_page_with_no_trip(self):
        self.store()
        for path in ("/books", "/books/7"):
            with self.subTest(path=path):
                self.sessions[MEMBER_SID].pop("kavita_token", None)
                self.assert_page(self.member().get(path), path)
                self.assertEqual(self.sessions[MEMBER_SID]["kavita_token"], FRESH)
                self.assertEqual(self.sessions[MEMBER_SID]["kavita_base"], KAVITA)

    def test_the_routers_fetch_gets_the_page_not_a_204(self):
        self.store()
        self.assert_page(self.member().get("/books", headers={"X-WS-Nav": "1"}), "/books")

    def test_a_refused_key_is_deleted_and_the_trip_starts(self):
        self.store()
        self.mint.side_effect = kavita.KavitaTokenRefused("rotated")
        r = self.member().get("/books")
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/kavita/connect?return=%2Fbooks"))
        self.assertIsNone(self.row())

    def test_no_key_starts_the_trip(self):
        r = self.member().get("/books")
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/kavita/connect?return=%2Fbooks"))
        self.mint.assert_not_awaited()

    def test_a_key_kept_for_another_address_starts_the_trip(self):
        self.store(base=ELSEWHERE)
        r = self.member().get("/books")
        self.assertEqual(r.status_code, 302)
        self.mint.assert_not_awaited()

    def test_kavita_not_answering_serves_the_page_and_keeps_the_key(self):
        self.store()
        self.mint.side_effect = kavita.KavitaUnavailable("down")
        self.assert_page(self.member().get("/books"), "/books")
        self.assertIsNotNone(self.row())

    def test_ebooks_off_for_a_member_mints_nothing(self):
        self.store()
        helpers.put(self.db, "sidebar.enabled_library", "false")
        self.member().get("/books")
        self.mint.assert_not_awaited()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class LogoutKeepsTheKey(KeysBase):
    def test_logging_out_deletes_the_session_and_leaves_the_key(self):
        self.store()
        helpers.set_rate_limits(False)
        self.addCleanup(helpers.set_rate_limits, True)
        client = helpers.api_client(self.Session, person(), headers=helpers.SAME_ORIGIN)
        self.addCleanup(helpers.reset_overrides)
        client.cookies.set(settings.session_cookie_name, "sid-1")
        gone = mock.AsyncMock()
        with mock.patch("app.routers.setup.is_setup_completed", return_value=True), \
             mock.patch.object(session_manager, "get_session", mock.AsyncMock(return_value=person())), \
             mock.patch.object(session_manager, "delete_session", gone):
            r = client.get("/auth/logout", follow_redirects=False)
        self.assertEqual(r.status_code, 302)
        gone.assert_awaited_once_with("sid-1")
        self.assertEqual(self.row().api_key, KEY)


if __name__ == "__main__":
    unittest.main()
