"""
The Books pages take the Kavita hand-off before they are drawn, never after.

A session with no Kavita sign-in used to get the Books page drawn (the
audiobook notice open, the books coming in) and then left for /kavita/connect
by the page's own script, coming back to a second load of it: the page
"loads, then reloads". Now the page's own address answers first:

- a full load is sent to /kavita/connect?return=<this address>, which keeps
  the time in the session (kavita_connect_at), so a trip started by a page's
  script or the reader holds the pages off just the same;
- the router's fetch (X-WS-Nav: 1) gets a 204, which it loads in full;
- it can never loop: not after a failed sign-in (?kavita=error), not within a
  minute of the last trip;
- nobody is sent who has nothing to connect: Kavita not set up, eBooks off
  for a member, a token already held for this address.

And a token Kavita has let lapse is renewed from the person's own key, the
same exchange the connect makes (kavita.person_token), so it needs no trip;
when Kavita will not take the key, the page's hand-off still runs.
"""
import time
import unittest
from unittest import mock
from urllib.parse import quote

try:
    import httpx

    from app.auth import session_manager
    from app.integrations import kavita
    from app.routers import books, kavita_proxy
    from app.tests import helpers
    from app.tests.test_settings_gate import MEMBER_SID, ADMIN_SID, SettingsGateBase
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False
    SettingsGateBase = unittest.TestCase

KAVITA = "http://kavita.test:5000"
PAGES = ["/books", "/books/7", "/books/series?name=Dune", "/books/person?role=author&name=Le%20Guin"]


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class HandOffFirst(SettingsGateBase):
    def setUp(self):
        super().setUp()
        helpers.put(self.db, "integration.kavita.url", KAVITA)
        self.sessions = {MEMBER_SID: dict(helpers.MEMBER), ADMIN_SID: dict(helpers.ADMIN)}

        async def get_session(session_id):
            return self.sessions.get(session_id)

        async def update(session_id, fields):
            if session_id in self.sessions:
                self.sessions[session_id].update(fields)

        self.update = mock.AsyncMock(side_effect=update)
        for patch in (mock.patch.object(session_manager, "get_session", side_effect=get_session),
                      mock.patch.object(session_manager, "update_session", self.update)):
            patch.start()
            self.addCleanup(patch.stop)

    def member(self, **fields):
        self.sessions[MEMBER_SID].update(fields)
        return self.client(MEMBER_SID)

    def assert_page(self, r, path):
        self.assertEqual(r.status_code, 200, path)
        self.assertIn('id="ws-data"', r.text, path)

    def test_a_full_load_without_a_kavita_sign_in_goes_to_connect_first(self):
        for path in PAGES:
            with self.subTest(path=path):
                self.update.reset_mock()
                self.sessions[MEMBER_SID].pop("kavita_connect_at", None)
                r = self.member().get(path)
                self.assertEqual(r.status_code, 302, path)
                self.assertEqual(r.headers["location"], "/kavita/connect?return=" + quote(path, safe=""))
                self.update.assert_not_awaited()          # /kavita/connect records the trip

    def connect(self, query):
        """The trip itself, with Kavita not answering (it comes back flagged)."""
        with mock.patch.object(kavita_proxy, "kavita_url_for", return_value=KAVITA):
            return self.member().get("/kavita/connect" + query)

    def test_the_trip_records_its_own_time(self):
        r = self.connect("?return=" + quote("/books/7", safe=""))
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/books/7?kavita=error"))
        self.assertAlmostEqual(int(self.sessions[MEMBER_SID]["kavita_connect_at"]), time.time(), delta=5)

    def test_a_trip_the_pages_script_started_holds_the_pages_off(self):
        # The page's script (or the reader) went to /kavita/connect itself and
        # it failed. Within the minute, a soft navigation to another Books
        # page is answered with the page (no 204, so no second trip), and so
        # is a full load.
        self.sessions[MEMBER_SID].pop("kavita_connect_at", None)
        self.connect("?return=" + quote("/books", safe=""))
        c = self.member()
        self.assert_page(c.get("/books/person?role=author&name=X", headers={"X-WS-Nav": "1"}), "soft nav")
        self.assert_page(c.get("/books/7"), "full load")

    def test_the_admin_is_sent_too(self):
        r = self.client(ADMIN_SID).get("/books")
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/kavita/connect?return=%2Fbooks"))

    def test_the_routers_fetch_gets_a_204_and_records_nothing(self):
        for path in PAGES:
            with self.subTest(path=path):
                r = self.member().get(path, headers={"X-WS-Nav": "1"})
                self.assertEqual((r.status_code, r.content), (204, b""))
        self.update.assert_not_awaited()

    def test_it_never_loops(self):
        # Back from a failed sign-in: the page, which says so.
        r = self.member().get("/books?kavita=error")
        self.assert_page(r, "/books?kavita=error")
        # Back from a trip less than a minute ago (the sign-in left no token): the page.
        c = self.member(kavita_connect_at=str(int(time.time()) - 10))
        for headers in ({}, {"X-WS-Nav": "1"}):
            self.assert_page(c.get("/books", headers=headers), "/books")
        self.update.assert_not_awaited()
        # A minute on, it may try again.
        r = self.member(kavita_connect_at=str(int(time.time()) - 120)).get("/books")
        self.assertEqual(r.status_code, 302)
        # A time that can't be read is no time: it may try.
        r = self.member(kavita_connect_at="junk").get("/books")
        self.assertEqual(r.status_code, 302)

    def test_a_held_token_for_this_address_is_served_the_page(self):
        c = self.member(kavita_token="jwt", kavita_base=KAVITA)
        for headers in ({}, {"X-WS-Nav": "1"}):
            self.assert_page(c.get("/books", headers=headers), "/books")
        # One from another address is no sign-in here.
        r = self.member(kavita_token="jwt", kavita_base="http://old-kavita:5000").get("/books")
        self.assertEqual(r.status_code, 302)

    def test_nobody_is_sent_when_kavita_is_not_set_up(self):
        helpers.put(self.db, "integration.kavita.url", "")
        for sid in (MEMBER_SID, ADMIN_SID):
            for headers in ({}, {"X-WS-Nav": "1"}):
                with self.subTest(sid=sid, soft=bool(headers)):
                    self.assert_page(self.client(sid).get("/books", headers=headers), "/books")
        self.update.assert_not_awaited()

    def test_your_stats_never_sends_anyone(self):
        self.assert_page(self.member().get("/books/stats"), "/books/stats")

    def test_a_trip_that_cannot_be_recorded_does_not_start(self):
        # Unrecorded, it could repeat: back to the page, flagged, which
        # makes no automatic attempt.
        self.update.side_effect = RuntimeError("redis down")
        with self.assertLogs(kavita_proxy.logger, "WARNING") as logs:
            r = self.connect("?return=" + quote("/books/7", safe=""))
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/books/7?kavita=error"))
        self.assertNotIn(MEMBER_SID, "\n".join(logs.output))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class RenewedToken(unittest.TestCase):
    """books._kavita_reach: a refused token is renewed once from the person's own key."""

    def run_async(self, coro):
        import asyncio
        return asyncio.run(coro)

    def setUp(self):
        self.update = mock.AsyncMock()
        self.series = mock.AsyncMock()
        self.renew = mock.AsyncMock(return_value="fresh-jwt")
        for patch in (mock.patch.object(books.kavita_proxy, "kavita_url_for", side_effect=lambda user: KAVITA),
                      mock.patch.object(session_manager, "update_session", self.update),
                      mock.patch.object(kavita, "user_series_ids", self.series),
                      mock.patch.object(kavita, "person_token", self.renew)):
            patch.start()
            self.addCleanup(patch.stop)
        self.user = {"kavita_token": "old-jwt", "kavita_base": KAVITA, "kavita_api_key": "person-key"}

    def test_a_lapsed_token_is_renewed_and_saved_without_a_trip(self):
        self.series.side_effect = [kavita.KavitaTokenRefused("expired"), {1, 2}]
        series, reach, note = self.run_async(books._kavita_reach(self.user, "sid-1"))
        self.assertEqual((series, reach, note), ({1, 2}, (KAVITA, "fresh-jwt"), None))
        self.renew.assert_awaited_once_with(KAVITA, "person-key")
        self.update.assert_awaited_once_with("sid-1", {"kavita_token": "fresh-jwt"})

    def test_a_key_kavita_refuses_falls_through_to_the_hand_off(self):
        self.series.side_effect = kavita.KavitaTokenRefused("expired")
        self.renew.side_effect = kavita.KavitaTokenRefused("refused")
        _series, reach, note = self.run_async(books._kavita_reach(self.user, "sid-1"))
        self.assertIsNone(reach)
        self.assertEqual(note["reason"], "not_connected")
        self.update.assert_not_awaited()

    def test_a_renewal_kavita_does_not_answer_is_unavailable_not_a_trip(self):
        # The token refused, then Plugin/authenticate times out: a sign-in
        # trip would not help, so the page says Kavita isn't answering.
        self.series.side_effect = kavita.KavitaTokenRefused("expired")
        self.renew.side_effect = kavita.KavitaUnavailable("Kavita did not answer")
        _series, reach, note = self.run_async(books._kavita_reach(self.user, "sid-1"))
        self.assertEqual((reach, note["reason"], note["text"]), (None, "unavailable", books.EBOOKS_DOWN))
        self.update.assert_not_awaited()

    def test_a_renewed_token_kavita_still_refuses_is_not_connected(self):
        self.series.side_effect = kavita.KavitaTokenRefused("expired")
        _series, reach, note = self.run_async(books._kavita_reach(self.user, "sid-1"))
        self.assertEqual((reach, note["reason"]), (None, "not_connected"))
        self.assertEqual(self.series.await_count, 2)                 # once, never a loop

    def test_no_key_or_no_session_asks_nothing(self):
        self.series.side_effect = kavita.KavitaTokenRefused("expired")
        for user, sid in ((dict(self.user, kavita_api_key=""), "sid-1"), (self.user, None)):
            _series, reach, note = self.run_async(books._kavita_reach(user, sid))
            self.assertEqual(note["reason"], "not_connected")
        self.renew.assert_not_awaited()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class PersonToken(unittest.TestCase):
    """kavita.person_token: the connect's own exchange, and nothing it says carries the key or a token."""

    KEY = "person-key-123"

    def call(self, answer):
        seen = []

        def handler(request):
            seen.append(request)
            if isinstance(answer, Exception):
                raise answer
            return answer

        transport = httpx.MockTransport(handler)
        real = httpx.AsyncClient

        def client(*args, **kwargs):
            kwargs["transport"] = transport
            return real(*args, **kwargs)

        import asyncio
        with mock.patch.object(kavita.httpx, "AsyncClient", side_effect=client):
            try:
                return asyncio.run(kavita.person_token(KAVITA, self.KEY)), seen
            except Exception as exc:  # noqa: BLE001 - the test reads it
                return exc, seen

    def test_the_same_exchange_as_the_connect(self):
        token, seen = self.call(httpx.Response(200, json={"token": "fresh-jwt"}))
        self.assertEqual(token, "fresh-jwt")
        (request,) = seen
        self.assertEqual((request.method, request.url.path), ("POST", "/api/Plugin/authenticate"))
        self.assertEqual(dict(request.url.params), {"apiKey": self.KEY, "pluginName": "WebServarr"})

    def test_refusals_and_failures_carry_no_secret(self):
        for answer, kind in ((httpx.Response(401), kavita.KavitaTokenRefused),
                             (httpx.Response(200, json={}), kavita.KavitaTokenRefused),
                             (httpx.Response(200, text="nope"), kavita.KavitaTokenRefused),
                             (httpx.ConnectError(f"failed {KAVITA}/?apiKey={self.KEY}"), kavita.KavitaUnavailable)):
            with self.subTest(answer=repr(answer)):
                exc, _seen = self.call(answer)
                self.assertIsInstance(exc, kind)
                self.assertNotIn(self.KEY, str(exc))
                self.assertIsNone(exc.__cause__)
