"""
The audiobook player's API (app/routers/player.py).

The Plex bridge is stubbed at its function boundary (it has its own tests in
test_plex_player.py, which stub Plex at the httpx layer); the listening store
is the real one on an in-memory database, so identity isolation and the
psid/seq rules are exercised end to end. No test reaches Plex, plex.tv,
Redis or the dev instance's settings.
"""
import json
import unittest
from unittest import mock

from app.tests import helpers

try:
    from fastapi import Request
    from app.config import settings
    from app.dependencies import get_current_user
    from app.integrations import plex_player as pp
    from app.limiter import limiter
    from app.main import app
    from app.models import ListeningLog, ListeningPosition
    from app.routers import player
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

ORIGIN = "https://localhost"


def plex_user(account_id, **extra):
    u = {"user_id": account_id, "username": f"listener{account_id}", "display_name": "Listener",
         "is_admin": "false", "auth_method": "plex", "plex_account_id": account_id,
         "plex_token": f"PLEX-TOKEN-{account_id}", "email": ""}
    u.update(extra)
    return u


A = plex_user("1001")
B = plex_user("1002")
LOCAL = {"user_id": "7", "username": "localsam", "is_admin": "true", "auth_method": "simple",
         "account_uid": "uid-7", "email": ""}
OIDC_ONLY = {"user_id": "sub-9", "username": "oidcsam", "is_admin": "false", "auth_method": "oidc",
             "email": "", "plex_token": "", "plex_account_id": ""}
# Signed in through Authentik with a linked Plex account: a Plex identity.
OIDC_PLEX = {"user_id": "sub-8", "username": "oidcplex", "is_admin": "false", "auth_method": "oidc",
             "email": "", "plex_token": "PLEX-TOKEN-8", "plex_account_id": "1008"}

# The stubbed library: book key -> its tracks and their durations.
LIBRARY = {"200:1": {"201": 100_000, "202": 200_000, "203": 300_000},
           "100:1": {"101": 1_000_000}}
STREAM = {"token": "SERVER-TOKEN-x", "uris": {"local": ["https://a.hash.plex.direct:32400"],
                                             "remote": ["https://b.hash.plex.direct:32400"]}}
BOOKS = [
    {"key": "100:1", "title": "Single Book", "author": "Ann Author", "series": "", "narrator": "Nora",
     "cover": "/library/metadata/100/thumb/1700000000", "duration_ms": 1_000_000, "shape": "single"},
    {"key": "200:1", "title": "Parts Book", "author": "Bea Writer", "series": "", "narrator": "",
     "cover": "", "duration_ms": 600_000, "shape": "parts"},
]


async def fake_assert_in_library(key, track_key=None):
    pp.parse_key(key)
    if key not in LIBRARY:
        raise pp.NotInLibrary("Not in the audiobook library")
    if track_key is not None and track_key not in LIBRARY[key]:
        raise pp.NotInLibrary("Not in this book")


async def fake_cover_image(key):
    await fake_assert_in_library(key)
    return b"\xff\xd8jpeg", "image/jpeg"


async def fake_book_detail(key):
    pp.parse_key(key)
    if key not in LIBRARY:
        raise pp.NotInLibrary("Not in the audiobook library")
    tracks = [{"key": k, "part_path": f"/library/parts/{k}/1/file.mp3", "duration_ms": d, "index": i + 1}
              for i, (k, d) in enumerate(LIBRARY[key].items())]
    return {**next(b for b in BOOKS if b["key"] == key), "tracks": tracks, "chapters": []}


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class PlayerApiBase(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.timeline = mock.AsyncMock(return_value=None)
        self.library_access = mock.AsyncMock(return_value=STREAM)
        self.plex_position = mock.AsyncMock(return_value=None)
        self.cover_image = mock.AsyncMock(side_effect=fake_cover_image)
        self.on = mock.Mock(return_value=True)
        patches = [
            mock.patch("app.routers.setup.is_setup_completed", return_value=True),
            mock.patch.object(pp, "player_on", self.on),
            mock.patch.object(pp, "assert_in_library", side_effect=fake_assert_in_library),
            mock.patch.object(pp, "book_detail", side_effect=fake_book_detail),
            mock.patch.object(pp, "list_books", mock.AsyncMock(return_value=[dict(b) for b in BOOKS])),
            mock.patch.object(pp, "library_access", self.library_access),
            mock.patch.object(pp, "plex_position", self.plex_position),
            mock.patch.object(pp, "timeline", self.timeline),
            mock.patch.object(pp, "cover_image", self.cover_image),
            mock.patch.object(settings, "app_domain", "localhost"),
            mock.patch.object(settings, "app_scheme", "https"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(helpers.reset_overrides)
        self.addCleanup(self.db.close)
        self.as_user(A)

    def as_user(self, user):
        self.client = helpers.api_client(self.Session, user)
        self.client.cookies.set(settings.session_cookie_name, f"sid-{user.get('user_id')}")
        return self.client

    def checkin(self, **fields):
        body = {"book": "200:1", "track": "202", "offset_ms": 5_000, "duration_ms": 200_000,
                "event": "checkin", "device": "Chrome on Linux", "psid": "psid-a", "seq": 1}
        body.update(fields)
        return self.client.post("/api/player/checkin", json=body, headers={"Origin": ORIGIN})

    def position(self, key="200:1"):
        r = self.client.get(f"/api/player/position/{key}")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["web"]


class StatusCodes(PlayerApiBase):
    ROUTES = [("get", "/api/player/books"), ("get", "/api/player/book/200:1"),
              ("get", "/api/player/cover/200:1"), ("get", "/api/player/position/200:1"),
              ("get", "/api/player/history/200:1"), ("get", "/api/player/prefs"),
              ("put", "/api/player/prefs"), ("post", "/api/player/checkin")]

    def call(self, method, path):
        if method == "get":
            return self.client.get(path)
        body = {"skip_s": 15} if path.endswith("prefs") else {
            "book": "200:1", "track": "201", "offset_ms": 0, "duration_ms": 100_000, "event": "play",
            "device": "", "psid": "p", "seq": 0}
        return getattr(self.client, method)(path, json=body, headers={"Origin": ORIGIN})

    def test_every_route_works_for_a_plex_listener(self):
        for method, path in self.ROUTES:
            with self.subTest(path=path, method=method):
                self.assertEqual(self.call(method, path).status_code, 200)

    def test_401_without_a_session(self):
        app.dependency_overrides.pop(get_current_user)
        self.client.cookies.clear()
        for method, path in self.ROUTES:
            with self.subTest(path=path, method=method):
                self.assertEqual(self.call(method, path).status_code, 401)

    def test_403_for_local_and_authentik_only_accounts(self):
        for user in (LOCAL, OIDC_ONLY):
            self.as_user(user)
            for method, path in self.ROUTES:
                with self.subTest(user=user["username"], path=path, method=method):
                    r = self.call(method, path)
                    self.assertEqual(r.status_code, 403)
                    self.assertEqual(r.json()["detail"], player.NEEDS_PLEX)
        self.assertEqual(self.db.query(ListeningPosition).count(), 0)

    def test_an_authentik_session_with_a_plex_account_is_a_listener(self):
        self.as_user(OIDC_PLEX)
        self.assertEqual(self.call("post", "/api/player/checkin").status_code, 200)
        self.assertEqual(self.db.query(ListeningPosition).one().identity, "plex:1008")

    def test_404_on_every_route_while_the_player_is_off(self):
        self.on.return_value = False
        for user in (A, LOCAL):
            self.as_user(user)
            for method, path in self.ROUTES:
                with self.subTest(user=user["username"], path=path, method=method):
                    self.assertEqual(self.call(method, path).status_code, 404)
        self.assertEqual(self.db.query(ListeningPosition).count(), 0)
        self.library_access.assert_not_awaited()

    def test_player_off_from_the_bridge_is_404(self):
        with mock.patch.object(pp, "list_books", mock.AsyncMock(side_effect=pp.PlayerOff("off"))):
            self.assertEqual(self.client.get("/api/player/books").status_code, 404)

    def test_404_for_keys_outside_the_library(self):
        for path in ("/api/player/book/999:1", "/api/player/position/999:1", "/api/player/history/999:1",
                     "/api/player/cover/999:1", "/api/player/book/not-a-key", "/api/player/position/1:x"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)
        # A track from another book, and a book that is not in the library.
        self.assertEqual(self.checkin(track="101").status_code, 404)
        self.assertEqual(self.checkin(book="999:1").status_code, 404)
        self.assertEqual(self.checkin(book="junk").status_code, 404)
        self.assertEqual(self.db.query(ListeningPosition).count(), 0)
        self.timeline.assert_not_awaited()

    def test_503_when_plex_is_unavailable(self):
        down = mock.AsyncMock(side_effect=pp.PlayerUnavailable("Plex is unavailable"))
        with mock.patch.object(pp, "assert_in_library", down):
            for path in ("/api/player/position/200:1", "/api/player/history/200:1"):
                self.assertEqual(self.client.get(path).status_code, 503, path)
            self.assertEqual(self.checkin().status_code, 503)
        with mock.patch.object(pp, "cover_image", down):
            self.assertEqual(self.client.get("/api/player/cover/200:1").status_code, 503)
        with mock.patch.object(pp, "list_books", down):
            self.assertEqual(self.client.get("/api/player/books").status_code, 503)
        with mock.patch.object(pp, "book_detail", down):
            self.assertEqual(self.client.get("/api/player/book/200:1").status_code, 503)
        self.assertEqual(self.db.query(ListeningPosition).count(), 0)

    def test_errors_never_use_a_cloudflare_replaced_status(self):
        for exc in (pp.PlayerUnavailable("x"), pp.TokenRejected("x"), pp.NoServerAccess("x"),
                    pp.NoLibraryAccess("x"), pp.NotInLibrary("x"), pp.PlayerOff("x")):
            for forbid in (False, True):
                code = player._http_error(exc, forbid=forbid).status_code
                self.assertTrue(400 <= code < 500 or code == 503, (exc, code))


class Access(PlayerApiBase):
    def test_books_and_book_check_the_listeners_own_library_access_first(self):
        r = self.client.get("/api/player/books")
        self.assertEqual(r.status_code, 200)
        session = self.library_access.await_args.args[0]
        self.assertEqual(session["plex_token"], A["plex_token"])
        self.assertEqual(self.library_access.await_args.kwargs["session_id"], "sid-1001")
        self.client.get("/api/player/book/200:1")
        self.assertEqual(self.library_access.await_args.kwargs["force"], False)

    def test_no_access_is_403_with_a_plain_message(self):
        for exc in (pp.NoServerAccess("not shared"), pp.NoLibraryAccess("section not shared")):
            self.library_access.side_effect = exc
            for path in ("/api/player/books", "/api/player/book/200:1"):
                with self.subTest(exc=type(exc).__name__, path=path):
                    r = self.client.get(path)
                    self.assertEqual(r.status_code, 403)
                    self.assertEqual(r.json()["detail"], "Your account doesn't have access to the audiobook library")

    def test_a_refused_token_or_an_outage_is_503(self):
        for exc in (pp.TokenRejected("401"), pp.PlayerUnavailable("down")):
            self.library_access.side_effect = exc
            for path in ("/api/player/books", "/api/player/book/200:1"):
                with self.subTest(exc=type(exc).__name__, path=path):
                    self.assertEqual(self.client.get(path).status_code, 503)

    def test_no_books_are_listed_without_access(self):
        self.library_access.side_effect = pp.NoLibraryAccess("x")
        r = self.client.get("/api/player/books")
        self.assertNotIn("Single Book", r.text)

    def test_refresh_forces_a_new_server_access(self):
        r = self.client.get("/api/player/book/200:1?refresh=1")
        self.assertEqual(r.status_code, 200)
        self.assertIs(self.library_access.await_args.kwargs["force"], True)

    def test_a_malformed_key_is_refused_before_any_plex_call(self):
        self.assertEqual(self.client.get("/api/player/book/200").status_code, 404)
        self.library_access.assert_not_awaited()


class Shapes(PlayerApiBase):
    def test_books_carry_same_origin_cover_urls(self):
        body = self.client.get("/api/player/books").json()
        self.assertEqual([b["key"] for b in body["books"]], ["100:1", "200:1"])
        self.assertEqual(body["books"][0]["cover"], "/api/player/cover/100:1?v=1700000000")
        self.assertEqual(body["books"][1]["cover"], "")
        self.assertEqual(set(body["books"][0]),
                         {"key", "title", "author", "series", "narrator", "cover", "duration_ms", "shape"})

    def test_book_carries_tracks_chapters_and_the_listeners_stream(self):
        r = self.client.get("/api/player/book/100:1")
        body = r.json()
        self.assertEqual(body["stream"], STREAM)
        self.assertEqual(body["cover"], "/api/player/cover/100:1?v=1700000000")
        self.assertEqual([t["key"] for t in body["tracks"]], ["101"])
        self.assertIn("chapters", body)
        self.assertEqual(r.headers["cache-control"], "no-store")

    def test_cover_is_an_image_cached_privately_for_a_long_time(self):
        r = self.client.get("/api/player/cover/100:1?v=1700000000")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.content, b"\xff\xd8jpeg")
        self.assertEqual(r.headers["content-type"], "image/jpeg")
        self.assertEqual(r.headers["cache-control"], f"private, max-age={30 * 24 * 3600}")
        self.assertEqual(r.headers["content-security-policy"], "sandbox")
        self.cover_image.assert_awaited_once_with("100:1")

    def test_position_has_web_and_plex_each_with_a_timestamp(self):
        plex = {"track": "203", "offset_ms": 1, "duration_ms": 300_000, "book_ms": 300_001,
                "book_duration_ms": 600_000, "updated_at": "2026-09-01T00:00:00.000Z", "device": "Plex",
                "source": "plex"}
        self.plex_position.return_value = plex
        self.assertEqual(self.client.get("/api/player/position/200:1").json(), {"web": None, "plex": plex})
        self.checkin()
        body = self.client.get("/api/player/position/200:1").json()
        self.assertEqual(body["web"]["track"], "202")
        self.assertEqual(body["web"]["offset_ms"], 5_000)
        self.assertTrue(body["web"]["updated_at"].endswith("Z"))
        self.assertEqual(body["plex"], plex)
        self.assertEqual(self.plex_position.await_args.kwargs["session_id"], "sid-1001")

    def test_position_still_resumes_when_the_listeners_plex_access_fails(self):
        self.checkin()
        for exc in (pp.PlayerUnavailable("down"), pp.TokenRejected("401"), pp.NoServerAccess("x")):
            self.plex_position.side_effect = exc
            r = self.client.get("/api/player/position/200:1")
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()["plex"], None)
            self.assertEqual(r.json()["web"]["offset_ms"], 5_000)

    def test_history_is_newest_first(self):
        self.checkin(seq=1, offset_ms=1_000, event="play")
        self.checkin(seq=2, offset_ms=2_000, event="pause")
        entries = self.client.get("/api/player/history/200:1").json()["entries"]
        self.assertEqual([e["offset_ms"] for e in entries], [2_000, 1_000])
        self.assertEqual(set(entries[0]), {"track", "offset_ms", "device", "event", "at"})

    def test_prefs_default_then_change(self):
        self.assertEqual(self.client.get("/api/player/prefs").json(),
                         {"skip_s": 10, "speed": 1.0, "smart_rewind": True})
        r = self.client.put("/api/player/prefs", json={"speed": 1.25}, headers={"Origin": ORIGIN})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"skip_s": 10, "speed": 1.25, "smart_rewind": True})

    def test_prefs_refuses_bad_values_and_unknown_or_reserved_keys(self):
        for body in ({"skip_s": 4}, {"speed": 1.33}, {"smart_rewind": "yes"}, {"volume": 3},
                     {"identity": "plex:1002"}, {"db": 1}, [1, 2]):
            with self.subTest(body=body):
                r = self.client.put("/api/player/prefs", json=body, headers={"Origin": ORIGIN})
                self.assertEqual(r.status_code, 422)
        self.assertEqual(self.client.get("/api/player/prefs").json()["speed"], 1.0)


class Checkins(PlayerApiBase):
    def test_a_checkin_stores_logs_and_forwards_to_plex(self):
        r = self.checkin(event="play", offset_ms=7_000)
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertIs(body["stored"], True)
        self.assertTrue(body["updated_at"].endswith("Z"))
        row = self.db.query(ListeningPosition).one()
        self.assertEqual((row.identity, row.book_key, row.track_key, row.offset_ms, row.source),
                         ("plex:1001", "200:1", "202", 7_000, "web"))
        self.assertEqual(self.db.query(ListeningLog).count(), 1)
        self.timeline.assert_awaited_once()
        args, kwargs = self.timeline.await_args
        self.assertEqual(args[1:], ("202", "playing", 7_000, 200_000))
        self.assertEqual(args[0]["plex_account_id"], "1001")
        self.assertEqual(kwargs, {"session_id": "sid-1001"})

    def test_the_track_is_checked_against_the_book_before_storing(self):
        calls = []

        async def spy(key, track_key=None):
            calls.append((key, track_key, self.db.query(ListeningPosition).count()))
            await fake_assert_in_library(key, track_key)
        with mock.patch.object(pp, "assert_in_library", side_effect=spy):
            self.checkin()
        self.assertEqual(calls, [("200:1", "202", 0)])

    def test_events_map_to_plex_states(self):
        expected = {"play": "playing", "checkin": "playing", "seek": "playing", "jump": "playing",
                    "pause": "paused", "leave": "paused", "end": "stopped"}
        self.assertEqual(player.EVENT_STATES, expected)
        for seq, (event, state) in enumerate(expected.items(), start=1):
            self.timeline.reset_mock()
            self.assertTrue(self.checkin(event=event, seq=seq).json()["stored"])
            self.assertEqual(self.timeline.await_args.args[2], state, event)

    def test_an_older_seq_from_the_same_psid_is_not_stored_or_forwarded(self):
        self.assertTrue(self.checkin(seq=5, offset_ms=50_000).json()["stored"])
        self.timeline.reset_mock()
        r = self.checkin(seq=4, offset_ms=40_000)
        self.assertEqual(r.status_code, 200)
        self.assertIs(r.json()["stored"], False)
        self.timeline.assert_not_awaited()
        self.assertEqual(self.position()["offset_ms"], 50_000)
        self.assertEqual(self.db.query(ListeningLog).count(), 1)

    def test_two_page_sessions_interleaving(self):
        # Review Focus 2: the same book open on two devices. The stored
        # position is the most recently received check-in, and a page session
        # never regresses its own stored position with a late, older seq.
        def send(psid, seq, offset):
            return self.checkin(psid=psid, seq=seq, offset_ms=offset, device=psid).json()["stored"]

        self.assertTrue(send("phone", 1, 10_000))
        self.assertTrue(send("laptop", 1, 90_000))
        self.assertEqual(self.position()["offset_ms"], 90_000)
        self.assertTrue(send("phone", 2, 11_000))           # most recently received wins
        self.assertEqual(self.position()["device"], "phone")
        self.assertEqual(self.position()["offset_ms"], 11_000)
        self.assertFalse(send("phone", 1, 10_000))          # phone's own late retry: refused
        self.assertEqual(self.position()["offset_ms"], 11_000)
        self.assertTrue(send("laptop", 2, 95_000))
        self.assertFalse(send("laptop", 1, 90_000))         # laptop's own late retry: refused
        self.assertEqual(self.position()["offset_ms"], 95_000)
        self.assertEqual(self.position()["device"], "laptop")
        # Only stored check-ins were forwarded to Plex, in order.
        forwarded = [c.args[3] for c in self.timeline.await_args_list]
        self.assertEqual(forwarded, [10_000, 90_000, 11_000, 95_000])

    def test_body_validation(self):
        bad = [
            {"offset_ms": -1},
            {"offset_ms": 200_001},                  # past the track's duration
            {"duration_ms": -5, "offset_ms": 0},
            {"event": "rewind"},
            {"event": ""},
            {"seq": -1},
            {"offset_ms": 1.5},
            {"offset_ms": "5000"},
            {"offset_ms": True},
            {"seq": "1"},
            {"psid": ""},
            {"psid": "p" * 65},
            {"book": ""},
            {"track": 202},
            {"device": "d" * 81},
        ]
        for fields in bad:
            with self.subTest(fields=fields):
                self.assertEqual(self.checkin(**fields).status_code, 422)
        for missing in ("book", "track", "offset_ms", "duration_ms", "event", "psid", "seq"):
            body = {"book": "200:1", "track": "202", "offset_ms": 1, "duration_ms": 2, "event": "play",
                    "psid": "p", "seq": 1}
            del body[missing]
            with self.subTest(missing=missing):
                r = self.client.post("/api/player/checkin", json=body, headers={"Origin": ORIGIN})
                self.assertEqual(r.status_code, 422)
        self.assertEqual(self.db.query(ListeningPosition).count(), 0)
        self.timeline.assert_not_awaited()
        # The edges are fine: offset 0, and offset equal to the duration.
        self.assertEqual(self.checkin(offset_ms=0, seq=1).status_code, 200)
        self.assertEqual(self.checkin(offset_ms=200_000, seq=2).status_code, 200)

    def test_a_slow_plex_timeline_runs_after_the_response_is_built(self):
        # The forward is a background task: the stored result is already
        # committed when it runs, so a slow or failing Plex cannot undo it.
        seen = []

        async def slow_timeline(*args, **kwargs):
            seen.append(self.db.query(ListeningPosition).count())
        self.timeline.side_effect = slow_timeline
        self.assertTrue(self.checkin().json()["stored"])
        self.assertEqual(seen, [1])


class SameOrigin(PlayerApiBase):
    """navigator.sendBeacon posts a Blob of type application/json with no
    custom header; the check-in accepts it from this origin only."""

    BODY = json.dumps({"book": "200:1", "track": "202", "offset_ms": 1_000, "duration_ms": 200_000,
                       "event": "leave", "device": "Firefox on Android", "psid": "beacon", "seq": 3})

    def beacon(self, **headers):
        return self.client.post("/api/player/checkin", content=self.BODY,
                                headers={"Content-Type": "application/json", **headers})

    def test_a_header_less_same_origin_beacon_is_accepted(self):
        r = self.beacon(Origin=ORIGIN)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["stored"])
        self.assertEqual(self.timeline.await_args.args[2], "paused")

    def test_the_requests_own_host_is_same_origin_too(self):
        self.assertEqual(self.beacon(Origin="https://testserver").status_code, 200)

    def test_referer_stands_in_when_there_is_no_origin(self):
        self.assertEqual(self.beacon(Referer=ORIGIN + "/ebooks?x=1").status_code, 200)

    def test_cross_origin_is_rejected(self):
        for headers in ({"Origin": "https://evil.example"},
                        {"Origin": "https://sub.localhost"},
                        {"Origin": "http://localhost"},          # other scheme
                        {"Origin": "https://localhost:8443"},    # other port
                        {"Origin": "null"},
                        {"Origin": "null", "Referer": ORIGIN + "/"},
                        {"Referer": "https://evil.example/page"},
                        {}):                                     # neither header
            with self.subTest(headers=headers):
                r = self.beacon(**headers)
                self.assertEqual(r.status_code, 403)
        self.assertEqual(self.db.query(ListeningPosition).count(), 0)
        self.timeline.assert_not_awaited()

    def test_prefs_put_is_same_origin_only(self):
        r = self.client.put("/api/player/prefs", json={"speed": 1.5}, headers={"Origin": "https://evil.example"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.client.get("/api/player/prefs").json()["speed"], 1.0)


class IdentityIsolation(PlayerApiBase):
    def test_a_listener_never_reads_or_writes_anothers_rows(self):
        # A listens and sets prefs.
        self.checkin(book="200:1", track="203", offset_ms=123_000, seq=1)
        self.client.put("/api/player/prefs", json={"skip_s": 30}, headers={"Origin": ORIGIN})
        # B sees none of it.
        self.as_user(B)
        self.assertEqual(self.client.get("/api/player/position/200:1").json()["web"], None)
        self.assertEqual(self.client.get("/api/player/history/200:1").json()["entries"], [])
        self.assertEqual(self.client.get("/api/player/prefs").json()["skip_s"], 10)
        # B's check-in on the same book, same psid and a higher seq, is B's own row.
        self.checkin(book="200:1", track="201", offset_ms=1_000, seq=9)
        self.assertEqual(self.checkin(book="100:1", track="101", offset_ms=500_000, duration_ms=1_000_000,
                                      seq=10).status_code, 200)
        self.client.put("/api/player/prefs", json={"skip_s": 45}, headers={"Origin": ORIGIN})
        # Back to A: unchanged, and changing the book key reaches only A's (empty) rows.
        self.as_user(A)
        pos = self.position("200:1")
        self.assertEqual((pos["track"], pos["offset_ms"]), ("203", 123_000))
        self.assertEqual(self.client.get("/api/player/position/100:1").json()["web"], None)
        self.assertEqual(self.client.get("/api/player/history/100:1").json()["entries"], [])
        self.assertEqual([e["offset_ms"] for e in self.client.get("/api/player/history/200:1").json()["entries"]],
                         [123_000])
        self.assertEqual(self.client.get("/api/player/prefs").json()["skip_s"], 30)
        rows = {(r.identity, r.book_key): r.offset_ms for r in self.db.query(ListeningPosition).all()}
        self.assertEqual(rows, {("plex:1001", "200:1"): 123_000, ("plex:1002", "200:1"): 1_000,
                                ("plex:1002", "100:1"): 500_000})

    def test_the_body_cannot_choose_the_identity(self):
        r = self.client.post("/api/player/checkin", headers={"Origin": ORIGIN}, json={
            "book": "200:1", "track": "202", "offset_ms": 1, "duration_ms": 2, "event": "play",
            "psid": "p", "seq": 1, "identity": "plex:1002", "source": "plex"})
        self.assertEqual(r.status_code, 200)
        row = self.db.query(ListeningPosition).one()
        self.assertEqual((row.identity, row.source), ("plex:1001", "web"))

    def test_the_forward_uses_the_listeners_own_session(self):
        self.as_user(B)
        self.checkin()
        self.assertEqual(self.timeline.await_args.args[0]["plex_account_id"], "1002")
        self.assertEqual(self.timeline.await_args.kwargs["session_id"], "sid-1002")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class RateLimits(unittest.TestCase):
    def limits(self, func):
        name = f"{func.__module__}.{func.__name__}"
        return [(str(lim.limit), lim.key_func) for lim in limiter._route_limits[name]]

    def test_each_route_is_limited_per_session(self):
        expected = {"books": "60 per 1 minute", "book": "60 per 1 minute", "position": "60 per 1 minute",
                    "history": "60 per 1 minute", "get_prefs": "60 per 1 minute", "put_prefs": "60 per 1 minute",
                    "checkin": "60 per 1 minute", "cover": "240 per 1 minute"}
        for name, limit in expected.items():
            with self.subTest(route=name):
                self.assertEqual(self.limits(getattr(player, name)), [(limit, player.session_rate_key)])

    def request(self, cookie=None, peer="203.0.113.5"):
        headers = [(b"cookie", f"{settings.session_cookie_name}={cookie}".encode())] if cookie else []
        return Request({"type": "http", "method": "GET", "path": "/", "headers": headers,
                        "client": (peer, 1234), "query_string": b""})

    def test_the_key_is_a_hash_of_the_session_cookie_else_the_ip(self):
        a1 = player.session_rate_key(self.request("sid-a"))
        a2 = player.session_rate_key(self.request("sid-a", peer="198.51.100.7"))
        b = player.session_rate_key(self.request("sid-b"))
        self.assertEqual(a1, a2)                 # one listener, wherever they are
        self.assertNotEqual(a1, b)               # two listeners behind one address
        self.assertNotIn("sid-a", a1)            # the cookie itself never becomes a key
        self.assertEqual(player.session_rate_key(self.request()), "203.0.113.5")


if __name__ == "__main__":
    unittest.main()
