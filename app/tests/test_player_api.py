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
        self.next_in_series = mock.AsyncMock(return_value=None)
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
            mock.patch.object(pp, "next_in_series", self.next_in_series),
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
              ("get", "/api/player/history/200:1"), ("get", "/api/player/next/200:1"),
              ("get", "/api/player/prefs"), ("put", "/api/player/prefs"), ("post", "/api/player/checkin")]

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

    def test_a_bad_key_with_refresh_makes_no_plex_tv_call(self):
        # library_access is the only way to plex.tv; a key that is malformed
        # or not in the library never reaches it, refresh or not.
        for path in ("/api/player/book/abc?refresh=1", "/api/player/book/999:1?refresh=1",
                     "/api/player/book/200:9x?refresh=1"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)
        self.library_access.assert_not_awaited()

    def test_every_keyed_read_needs_the_listeners_library_access(self):
        for exc in (pp.NoServerAccess("not shared"), pp.NoLibraryAccess("section not shared")):
            self.library_access.side_effect = exc
            for path in ("/api/player/book/200:1", "/api/player/cover/200:1",
                         "/api/player/position/200:1", "/api/player/history/200:1"):
                with self.subTest(exc=type(exc).__name__, path=path):
                    r = self.client.get(path)
                    self.assertEqual(r.status_code, 403)
                    self.assertEqual(r.json()["detail"], player.NO_ACCESS)
        self.cover_image.assert_not_awaited()
        self.plex_position.assert_not_awaited()

    def test_a_keyed_read_checks_the_key_before_access(self):
        for path in ("/api/player/cover/999:1", "/api/player/position/999:1", "/api/player/history/999:1"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)
        self.library_access.assert_not_awaited()

    def test_checkin_is_not_gated_on_library_access(self):
        self.library_access.side_effect = pp.NoLibraryAccess("x")
        self.assertTrue(self.checkin().json()["stored"])
        self.library_access.assert_not_awaited()

    def test_keyed_reads_refused_by_a_rejected_token_are_503(self):
        self.library_access.side_effect = pp.TokenRejected("401")
        for path in ("/api/player/cover/200:1", "/api/player/position/200:1", "/api/player/history/200:1"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 503)


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
        first = self.client.get("/api/player/position/200:1").json()
        self.assertEqual({k: first[k] for k in ("web", "plex")}, {"web": None, "plex": plex})
        self.checkin()
        body = self.client.get("/api/player/position/200:1").json()
        self.assertEqual(body["web"]["track"], "202")
        self.assertEqual(body["web"]["offset_ms"], 5_000)
        self.assertTrue(body["web"]["updated_at"].endswith("Z"))
        self.assertEqual(body["plex"], plex)
        self.assertEqual(self.plex_position.await_args.kwargs["session_id"], "sid-1001")

    def test_position_carries_the_servers_clock(self):
        # The player measures its clock against `now` before it compares its
        # local copy (stamped in the server's time) with these.
        from datetime import datetime, timezone
        before = datetime.now(timezone.utc)
        body = self.client.get("/api/player/position/200:1").json()
        after = datetime.now(timezone.utc)
        self.assertEqual(set(body), {"web", "plex", "now"})
        self.assertRegex(body["now"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        at = datetime.fromisoformat(body["now"].replace("Z", "+00:00"))
        self.assertLessEqual(before.replace(microsecond=before.microsecond // 1000 * 1000), at)
        self.assertLessEqual(at, after)
        # It is the same clock the stored place is stamped with.
        self.checkin()
        body = self.client.get("/api/player/position/200:1").json()
        self.assertLessEqual(body["web"]["updated_at"], body["now"])

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
        body = self.client.get("/api/player/history/200:1").json()
        entries = body["entries"]
        self.assertIsNone(body["next_before"])
        self.assertEqual([e["offset_ms"] for e in entries], [2_000, 1_000])
        self.assertEqual(set(entries[0]), {"track", "offset_ms", "device", "device_id", "event", "at"})

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

    def test_prefs_numbers_too_big_to_handle_are_422(self):
        for body in ({"speed": 1e308}, {"speed": -1e308}, {"speed": 10 ** 400}, {"speed": -(10 ** 400)},
                     {"skip_s": 10 ** 400}, {"speed": 1e-320}):
            with self.subTest(body=str(body)[:40]):
                r = self.client.put("/api/player/prefs", json=body, headers={"Origin": ORIGIN})
                self.assertEqual(r.status_code, 422)
        for raw in (b'{"speed": 1e400}', b'{"speed": -1e400}', b'{"speed": NaN}', b'{"speed": Infinity}'):
            with self.subTest(raw=raw):
                r = self.client.put("/api/player/prefs", content=raw,
                                    headers={"Origin": ORIGIN, "Content-Type": "application/json"})
                self.assertEqual(r.status_code, 422)
        self.assertEqual(self.client.get("/api/player/prefs").json(),
                         {"skip_s": 10, "speed": 1.0, "smart_rewind": True})


class History(PlayerApiBase):
    ROWS = 1_250

    def fill(self, identity="plex:1001", book="200:1"):
        from datetime import datetime, timedelta
        base = datetime(2026, 9, 1, 12, 0, 0)
        # Runs of up to seven rows share one instant, including runs that
        # straddle every page boundary tried below.
        rows = [ListeningLog(identity=identity, book_key=book, track_key="202", offset_ms=n,
                             device="d", event="checkin", at=base + timedelta(seconds=n // 7))
                for n in range(self.ROWS)]
        self.db.add_all(rows)
        self.db.commit()

    def pages(self, limit=None):
        out, before, n = [], None, 0
        while True:
            params = {}
            if limit is not None:
                params["limit"] = limit
            if before is not None:
                params["before"] = before
            r = self.client.get("/api/player/history/200:1", params=params)
            self.assertEqual(r.status_code, 200, r.text)
            body = r.json()
            self.assertLessEqual(len(body["entries"]), limit or 500)
            out.extend(e["offset_ms"] for e in body["entries"])
            n += 1
            before = body["next_before"]
            if before is None:
                return out, n
            self.assertLess(n, 2_000)

    def test_every_row_once_across_pages_newest_first(self):
        self.fill()
        self.fill(identity="plex:1002")          # another listener's rows never appear
        for limit in (None, 1_000, 499, 7, 3):
            with self.subTest(limit=limit):
                got, pages = self.pages(limit)
                self.assertEqual(len(got), self.ROWS)
                self.assertEqual(len(set(got)), self.ROWS)            # no duplicates
                self.assertEqual(got, sorted(range(self.ROWS), reverse=True))   # no gaps, newest first
                size = limit or 500
                self.assertEqual(pages, -(-self.ROWS // size))

    def test_default_page_is_500_and_a_bare_instant_is_before_it(self):
        self.fill()
        body = self.client.get("/api/player/history/200:1").json()
        self.assertEqual(len(body["entries"]), 500)
        self.assertIsNotNone(body["next_before"])
        # An entry's own "at" as a bare instant: every row strictly older.
        r = self.client.get("/api/player/history/200:1", params={"before": "2026-09-01T12:00:01.000Z"})
        self.assertEqual([e["offset_ms"] for e in r.json()["entries"]], [6, 5, 4, 3, 2, 1, 0])
        self.assertIsNone(r.json()["next_before"])

    def test_bad_before_or_limit_is_422(self):
        self.fill()
        for params in ({"limit": 0}, {"limit": 1_001}, {"limit": -1}, {"limit": "ten"}, {"limit": 1.5},
                       {"before": "yesterday"}, {"before": "2026-13-01T00:00:00Z"}, {"before": ""},
                       {"before": "~5"}, {"before": "2026-09-01T00:00:00Z~abc"},
                       {"before": "2026-09-01T00:00:00Z~"}, {"before": "2026-09-01T00:00:00Z" + "0" * 60}):
            with self.subTest(params=params):
                r = self.client.get("/api/player/history/200:1", params=params)
                self.assertEqual(r.status_code, 422)
        self.library_access.assert_not_awaited()


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
        # Review Focus 2: the same book open on two devices. A device stores
        # over the row it last saw (base), never over one it hasn't seen
        # (409), and a page session never regresses its own stored position
        # with a late, older seq.
        seen = {}

        def send(psid, seq, offset):
            r = self.checkin(psid=psid, seq=seq, offset_ms=offset, device=psid, base=seen.get(psid))
            if r.status_code == 200 and r.json()["stored"]:
                seen[psid] = r.json()["updated_at"]
            return r.status_code, r.json().get("stored")

        self.assertEqual(send("phone", 1, 10_000), (200, True))
        seen["laptop"] = self.position()["updated_at"]            # the laptop opens: it sees the phone's row
        self.assertEqual(send("laptop", 1, 90_000), (200, True))
        self.assertEqual(self.position()["offset_ms"], 90_000)
        self.assertEqual(send("phone", 2, 11_000)[0], 409)         # the phone hasn't seen the laptop's
        self.assertEqual(self.position()["offset_ms"], 90_000)
        self.assertEqual(send("laptop", 2, 95_000), (200, True))
        self.assertEqual(send("laptop", 1, 90_000), (200, False))  # laptop's own late retry: refused
        self.assertEqual(self.position()["offset_ms"], 95_000)
        seen["phone"] = self.position()["updated_at"]              # the phone is shown it, and goes on
        self.assertEqual(send("phone", 3, 12_000), (200, True))
        self.assertEqual(self.position()["device"], "phone")
        # Only stored check-ins were forwarded to Plex, in order.
        forwarded = [c.args[3] for c in self.timeline.await_args_list]
        self.assertEqual(forwarded, [10_000, 90_000, 95_000, 12_000])

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

    def test_text_that_is_not_valid_unicode_is_422(self):
        # A lone surrogate is valid JSON but no UTF-8 can hold it: refused
        # before the database, and the 422 itself must not choke on it.
        base = {"book": "200:1", "track": "202", "offset_ms": 1, "duration_ms": 2, "event": "play",
                "device": "Chrome", "psid": "p", "seq": 1}
        for field in ("device", "psid", "book", "track"):
            body = json.dumps({**base, field: "ab\ud800"})     # ASCII JSON: the escape itself
            with self.subTest(field=field):
                self.assertIn("\\ud800", body)
                r = self.client.post("/api/player/checkin", content=body.encode(),
                                     headers={"Origin": ORIGIN, "Content-Type": "application/json"})
                self.assertEqual(r.status_code, 422)
        for raw in ('{"speed": 1.25, "\\ud800": 1}', '{"smart_rewind": "\\udfff"}'):
            with self.subTest(raw=raw):
                r = self.client.put("/api/player/prefs", content=raw.encode(),
                                    headers={"Origin": ORIGIN, "Content-Type": "application/json"})
                self.assertEqual(r.status_code, 422)
        self.assertEqual(self.db.query(ListeningPosition).count(), 0)
        self.timeline.assert_not_awaited()
        # The schema refuses it too, for any caller that bypasses the route.
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            player.Checkin(**{**base, "device": "x\ud800"})

    def nested(self, levels):
        """A beacon body whose extra field nests arrays so the whole body is
        `levels` deep (the body object itself is level 1)."""
        inner = "1"
        for _ in range(levels - 1):
            inner = "[" + inner + "]"
        return ('{"book": "200:1", "track": "202", "offset_ms": 1, "duration_ms": 2, "event": "leave", '
                '"device": "d", "psid": "deep", "seq": 1, "x": ' + inner + "}").encode()

    def test_a_body_nested_too_deep_is_422_without_echo(self):
        for levels in (33, 400, 900, 950):
            with self.subTest(levels=levels):
                r = self.client.post("/api/player/checkin", content=self.nested(levels),
                                     headers={"Origin": ORIGIN, "Content-Type": "application/json"})
                self.assertEqual(r.status_code, 422)
                self.assertEqual(r.json(), {"detail": "The request is nested too deeply"})
                r = self.client.put("/api/player/prefs", content=b'{"x": ' + b"[" * (levels - 1) + b"1" +
                                    b"]" * (levels - 1) + b"}",
                                    headers={"Origin": ORIGIN, "Content-Type": "application/json"})
                self.assertEqual(r.status_code, 422)
        self.assertEqual(self.db.query(ListeningPosition).count(), 0)
        self.timeline.assert_not_awaited()
        # 32 levels is the most taken: the extra field is ignored and it stores.
        r = self.client.post("/api/player/checkin", content=self.nested(32),
                             headers={"Origin": ORIGIN, "Content-Type": "application/json"})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["stored"])

    def test_the_walk_is_not_recursive(self):
        deep = value = []
        for _ in range(50_000):
            value.append([])
            value = value[0]
        self.assertEqual(player._body_problem({"x": deep}), "depth")
        self.assertEqual(player._body_problem({"a": [{"b": ["ok", "\ud800"]}]}), "text")
        self.assertEqual(player._body_problem({"\udfff": 1}), "text")
        self.assertIsNone(player._body_problem({"a": [{"b": ["ok", 1, None, 2.5]}]}))

    def test_a_recursion_error_is_a_422_backstop(self):
        with mock.patch.object(player, "_body_problem", side_effect=RecursionError):
            r = self.checkin()
        self.assertEqual(r.status_code, 422)
        self.assertEqual(self.db.query(ListeningPosition).count(), 0)

    def test_a_plain_beacon_body_still_stores(self):
        r = self.client.post("/api/player/checkin", content=SameOrigin.BODY.encode(),
                             headers={"Origin": ORIGIN, "Content-Type": "application/json"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["stored"])

    def test_a_slow_plex_timeline_runs_after_the_response_is_built(self):
        # The forward is a background task: the stored result is already
        # committed when it runs, so a slow or failing Plex cannot undo it.
        seen = []

        async def slow_timeline(*args, **kwargs):
            seen.append(self.db.query(ListeningPosition).count())
        self.timeline.side_effect = slow_timeline
        self.assertTrue(self.checkin().json()["stored"])
        self.assertEqual(seen, [1])


class DeviceIds(PlayerApiBase):
    """Each browser sends its own random id with every check-in (optional,
    for older players); /position and /history hand it back."""

    PHONE = "q8w2e6r4t0y9u1i3o5p7a2s4"
    TABLET = "z" * 40

    def test_the_id_is_stored_and_read_back(self):
        self.assertEqual(self.checkin(device_id=self.PHONE).status_code, 200)
        self.assertEqual(self.position()["device_id"], self.PHONE)
        entries = self.client.get("/api/player/history/200:1").json()["entries"]
        self.assertEqual(entries[0]["device_id"], self.PHONE)
        self.assertEqual(self.db.query(ListeningLog).one().device_id, self.PHONE)

    def test_two_devices_with_one_label_stay_apart(self):
        first = self.checkin(device_id=self.PHONE, psid="p1", seq=1, device="Chrome on Android").json()
        self.checkin(device_id=self.TABLET, psid="p2", seq=1, device="Chrome on Android", base=first["updated_at"])
        web = self.position()
        self.assertEqual((web["device"], web["device_id"]), ("Chrome on Android", self.TABLET))
        ids = [e["device_id"] for e in self.client.get("/api/player/history/200:1").json()["entries"]]
        self.assertEqual(ids, [self.TABLET, self.PHONE])

    def test_no_id_is_null(self):
        self.checkin()
        self.assertIsNone(self.position()["device_id"])
        self.checkin(device_id=None, seq=2)
        self.assertIsNone(self.position()["device_id"])

    def test_a_malformed_id_is_422_and_nothing_is_stored(self):
        for bad in ("", "short", "A" * 20, "a" * 41, "abc-def-ghi-jkl-mno", 1234567890123456789, ["a" * 20],
                    "a" * 20 + "\n", "\u0430" * 20):
            with self.subTest(bad=bad):
                self.assertEqual(self.checkin(device_id=bad).status_code, 422)
        self.assertEqual(self.db.query(ListeningPosition).count(), 0)
        self.timeline.assert_not_awaited()


class PlexEchoes(PlayerApiBase):
    """Plex stamps a part again when it ends a session a save of ours began
    (about 75 s after a pause, about 10 s after a part change), so its copy
    of a place we logged looks newer while holding an older place. /position
    leaves such a copy out (plex: null); only a place we never logged, real
    listening in a Plex app, competes on its time."""

    def plex_at(self, track, offset, stamped=None):
        if stamped is None:
            from datetime import datetime, timezone
            stamped = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self.plex_position.return_value = {
            "track": track, "offset_ms": offset, "duration_ms": 300_000, "book_ms": 0,
            "book_duration_ms": 600_000, "updated_at": stamped, "device": "Plex", "source": "plex"}
        return self.plex_position.return_value

    def plex(self, key="200:1"):
        r = self.client.get(f"/api/player/position/{key}")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["plex"]

    def test_a_restamp_after_a_pause_is_left_out(self):
        self.checkin(track="202", offset_ms=150_000, event="pause")
        self.plex_at("202", 150_000)
        self.assertIsNone(self.plex())

    def test_a_restamp_of_the_old_part_after_a_part_change_is_left_out(self):
        self.checkin(track="201", offset_ms=90_000, seq=1)
        self.checkin(track="202", offset_ms=1_000, event="seek", seq=2)
        # Plex ran part 1 on a few seconds before its session ended.
        self.plex_at("201", 93_500)
        self.assertIsNone(self.plex())
        self.assertEqual(self.position()["track"], "202")

    def test_within_five_seconds_only(self):
        self.checkin(track="202", offset_ms=150_000, event="pause")
        for offset, echo in ((145_000, True), (155_000, True), (144_999, False), (155_001, False)):
            with self.subTest(offset=offset):
                self.plex_at("202", offset)
                self.assertEqual(self.plex() is None, echo)
        self.plex_at("203", 150_000)      # the same offset in another part
        self.assertIsNotNone(self.plex())

    def test_genuine_plex_listening_still_competes(self):
        self.checkin(track="202", offset_ms=150_000, event="pause")
        plex = self.plex_at("203", 50_000)
        self.assertEqual(self.plex(), plex)

    def test_no_log_is_the_old_behaviour(self):
        plex = self.plex_at("202", 150_000)
        self.assertEqual(self.plex(), plex)

    def test_only_the_listeners_own_log_counts(self):
        self.as_user(B)
        self.checkin(track="202", offset_ms=150_000, event="pause")
        self.as_user(A)
        plex = self.plex_at("202", 150_000)
        self.assertEqual(self.plex(), plex)
        # And only this book's.
        self.checkin(book="100:1", track="101", offset_ms=150_000, event="pause")
        self.assertEqual(self.plex(), plex)

    def test_a_log_row_over_a_day_old_does_not_count(self):
        from datetime import datetime, timedelta
        iso = lambda d: d.isoformat(timespec="milliseconds") + "Z"   # noqa: E731
        old = datetime.utcnow() - timedelta(hours=24, minutes=1)
        recent = datetime.utcnow() - timedelta(hours=23, minutes=59)
        for at in (old, recent):
            self.db.add(ListeningLog(identity="plex:1001", book_key="200:1", track_key="202", offset_ms=150_000,
                                     device="d", event="pause", at=at))
        self.db.commit()
        plex = self.plex_at("202", 150_000, stamped=iso(old))
        self.assertEqual(self.plex(), plex)
        self.plex_at("202", 150_000, stamped=iso(recent))
        self.assertIsNone(self.plex())

    def test_plex_at_a_logged_place_but_at_another_time_is_real_listening(self):
        # Plexamp went back to a place we logged, 5 minutes after we logged it.
        from datetime import datetime, timedelta
        iso = lambda d: d.isoformat(timespec="milliseconds") + "Z"   # noqa: E731
        at = datetime.utcnow() - timedelta(minutes=10)
        self.db.add(ListeningLog(identity="plex:1001", book_key="200:1", track_key="202", offset_ms=150_000,
                                 device="d", event="pause", at=at))
        self.db.commit()
        for delta, echo in ((29, True), (-29, True), (31, False), (-31, False), (300, False)):
            with self.subTest(delta=delta):
                self.plex_at("202", 150_000, stamped=iso(at + timedelta(seconds=delta)))
                self.assertEqual(self.plex() is None, echo)
        self.plex_at("202", 150_000, stamped="not a time")
        self.assertIsNotNone(self.plex())

    def test_web_is_read_after_the_echo_check(self):
        # A save that lands while Plex is being read is in `web`.
        self.checkin(track="202", offset_ms=150_000, event="pause")
        test = self

        async def plex_then_save(*a, **kw):
            test.checkin(track="202", offset_ms=160_000, event="pause", seq=2)
            return test.plex_at("202", 150_000)
        self.plex_position.side_effect = plex_then_save
        body = self.client.get("/api/player/position/200:1").json()
        self.assertIsNone(body["plex"])
        self.assertEqual(body["web"]["offset_ms"], 160_000)

    def test_the_query_uses_the_log_index(self):
        from sqlalchemy import text
        from datetime import datetime
        from app.services import listening
        plan = self.db.execute(text(
            "EXPLAIN QUERY PLAN SELECT id FROM listening_log WHERE identity = 'x' AND book_key = 'y' "
            "AND at >= :since AND track_key = 't' AND offset_ms BETWEEN 1 AND 2 LIMIT 1"),
            {"since": datetime(2026, 1, 1)}).all()
        self.assertIn("ix_listening_log_identity_book_at", " ".join(str(r) for r in plan))
        self.assertFalse(listening.is_logged_place(self.db, "plex:1001", "200:1", None, 5, datetime(2026, 1, 1)))
        self.assertFalse(listening.is_logged_place(self.db, "plex:1001", "200:1", "202", True, datetime(2026, 1, 1)))
        self.assertFalse(listening.is_logged_place(self.db, "plex:1001", "200:1", "202", 5, None))


class Conflicts(PlayerApiBase):
    """Spec 11b over HTTP: a check-in from another device that hasn't seen the
    stored row is 409 with that row, stores and forwards nothing, and is
    logged."""

    PHONE = "p" * 20
    DESK = "d" * 20

    def test_a_stale_device_gets_409_with_the_stored_place(self):
        desk = self.checkin(device_id=self.DESK, psid="desk", offset_ms=150_000, device="Chrome on Linux").json()
        self.timeline.reset_mock()
        r = self.checkin(device_id=self.PHONE, psid="phone", offset_ms=10_000, device="Chrome on Android")
        self.assertEqual(r.status_code, 409)
        body = r.json()
        self.assertEqual(set(body), {"conflict", "now"})
        self.assertEqual(body["conflict"], {"track": "202", "offset_ms": 150_000, "device": "Chrome on Linux",
                                            "updated_at": desk["updated_at"]})
        self.assertRegex(body["now"], r"Z$")
        self.assertEqual(self.position()["offset_ms"], 150_000)
        self.timeline.assert_not_awaited()
        self.assertEqual(self.db.query(ListeningLog).count(), 2)

    def test_the_base_it_was_shown_stores(self):
        desk = self.checkin(device_id=self.DESK, psid="desk", offset_ms=150_000).json()
        r = self.checkin(device_id=self.PHONE, psid="phone", offset_ms=10_000, base=desk["updated_at"])
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["stored"])
        self.assertEqual(self.position()["device_id"], self.PHONE)

    def test_a_beacon_is_refused_the_same_way(self):
        self.checkin(device_id=self.DESK, psid="desk", offset_ms=150_000)
        body = {"book": "200:1", "track": "202", "offset_ms": 1, "duration_ms": 200_000, "event": "leave",
                "device": "x", "psid": "phone", "seq": 9, "device_id": self.PHONE}
        r = self.client.post("/api/player/checkin", content=json.dumps(body),
                             headers={"Origin": ORIGIN, "Content-Type": "application/json"})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(self.position()["offset_ms"], 150_000)

    def test_the_conflict_is_never_another_listeners_row(self):
        self.as_user(B)
        self.checkin(device_id=self.DESK, psid="desk", offset_ms=150_000)
        self.as_user(A)
        r = self.checkin(device_id=self.PHONE, psid="phone", offset_ms=10_000)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["stored"])

    def test_base_is_validated(self):
        for bad in ("yesterday", "2026-99-01T00:00:00Z", "2" * 41, 12, ["x"], "\ud800",
                    "9999-12-31T23:59:59.999Z", "0001-01-01T00:00:00+01:00"):
            with self.subTest(bad=bad):
                self.assertEqual(self.checkin(base=bad).status_code, 422)
        self.assertEqual(self.db.query(ListeningPosition).count(), 0)
        for good in (None, "2026-09-29T12:00:00.123Z", "2026-09-29T12:00:00+00:00"):
            with self.subTest(good=good):
                self.assertEqual(self.checkin(base=good, seq=5).status_code, 200)


class NextInSeries(PlayerApiBase):
    NEXT = {"key": "100:1", "title": "Single Book", "author": "Ann Author", "series": "Saga",
            "narrator": "Nora", "cover": "/library/metadata/100/thumb/1700000000", "duration_ms": 1_000_000,
            "shape": "single"}

    def test_the_next_book_with_a_same_origin_cover(self):
        self.next_in_series.return_value = dict(self.NEXT)
        r = self.client.get("/api/player/next/200:1")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"next": {**self.NEXT, "cover": "/api/player/cover/100:1?v=1700000000"}})
        self.next_in_series.assert_awaited_once_with("200:1")

    def test_none_is_null(self):
        self.assertEqual(self.client.get("/api/player/next/100:1").json(), {"next": None})

    def test_the_key_is_checked_before_access_or_the_library_read(self):
        for path in ("/api/player/next/200", "/api/player/next/x:1", "/api/player/next/999:1",
                     "/api/player/next/1:1:1"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)
        self.library_access.assert_not_awaited()
        self.next_in_series.assert_not_awaited()

    def test_it_needs_the_listeners_library_access(self):
        for exc in (pp.NoServerAccess("not shared"), pp.NoLibraryAccess("section not shared")):
            self.library_access.side_effect = exc
            r = self.client.get("/api/player/next/200:1")
            self.assertEqual(r.status_code, 403)
            self.assertEqual(r.json()["detail"], player.NO_ACCESS)
        self.next_in_series.assert_not_awaited()

    def test_plex_down_is_503_and_player_off_is_404(self):
        self.next_in_series.side_effect = pp.PlayerUnavailable("down")
        self.assertEqual(self.client.get("/api/player/next/200:1").status_code, 503)
        self.next_in_series.side_effect = pp.PlayerOff("off")
        self.assertEqual(self.client.get("/api/player/next/200:1").status_code, 404)


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
        return [(str(lim.limit), lim.key_func, lim.scope) for lim in limiter._route_limits[name]]

    def test_each_route_has_one_budget_per_session(self):
        expected = {"books": ("60 per 1 minute", "books"), "book": ("60 per 1 minute", "book"),
                    "position": ("60 per 1 minute", "position"), "history": ("60 per 1 minute", "history"),
                    "get_prefs": ("60 per 1 minute", "prefs-get"), "put_prefs": ("60 per 1 minute", "prefs-put"),
                    "checkin": ("60 per 1 minute", "checkin"), "cover": ("240 per 1 minute", "cover"),
                    "next_book": ("60 per 1 minute", "next")}
        for name, (limit, scope) in expected.items():
            with self.subTest(route=name):
                self.assertEqual(self.limits(getattr(player, name)),
                                 [(limit, player.session_rate_key, f"player:{scope}")])

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


class LimitsAcrossKeys(PlayerApiBase):
    """The limits enforced for real, on an in-memory store (never the shared
    Redis): a budget is per route and session, not per book key."""

    def setUp(self):
        super().setUp()
        from limits.storage import MemoryStorage
        from limits.strategies import FixedWindowRateLimiter
        storage = MemoryStorage()
        for p in (mock.patch.object(limiter, "_storage", storage),
                  mock.patch.object(limiter, "_limiter", FixedWindowRateLimiter(storage))):
            p.start()
            self.addCleanup(p.stop)
        helpers.set_rate_limits(True)       # reset_overrides puts the earlier state back

    def test_position_budget_is_shared_by_every_book(self):
        codes = [self.client.get(f"/api/player/position/{('100:1', '200:1')[i % 2]}").status_code
                 for i in range(60)]
        self.assertEqual(set(codes), {200})
        self.assertEqual(self.client.get("/api/player/position/200:1").status_code, 429)
        self.assertEqual(self.client.get("/api/player/position/100:1").status_code, 429)
        # Another route has its own budget, and so has another session.
        self.assertEqual(self.client.get("/api/player/history/200:1").status_code, 200)
        self.client.cookies.set(settings.session_cookie_name, "sid-someone-else")
        self.assertEqual(self.client.get("/api/player/position/100:1").status_code, 200)

    def test_cover_budget_is_240_across_books(self):
        codes = [self.client.get(f"/api/player/cover/{('100:1', '200:1')[i % 2]}").status_code
                 for i in range(240)]
        self.assertEqual(set(codes), {200})
        self.assertEqual(self.client.get("/api/player/cover/100:1").status_code, 429)

    def test_next_budget_is_shared_by_every_book(self):
        codes = [self.client.get(f"/api/player/next/{('100:1', '200:1')[i % 2]}").status_code for i in range(60)]
        self.assertEqual(set(codes), {200})
        self.assertEqual(self.client.get("/api/player/next/100:1").status_code, 429)

    def test_checkin_budget_is_shared_by_every_book(self):
        for i in range(60):
            book, track = (("100:1", "101"), ("200:1", "202"))[i % 2]
            self.assertEqual(self.checkin(book=book, track=track, seq=i + 1).status_code, 200)
        self.assertEqual(self.checkin(book="100:1", track="101", seq=100).status_code, 429)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class LauncherPage(unittest.TestCase):
    """The player's test launcher (/player-test, Task 10): a page, not an API
    route, for admins only and only while the player is on. Everyone else,
    signed in or not, gets the same 404 as an address that does not exist,
    so the page is not there for them at all. Nothing in the navigation
    links to it."""

    ADMIN = {"username": "admin", "display_name": "Admin", "is_admin": "true",
             "auth_method": "plex", "plex_account_id": "1001", "avatar_url": ""}
    MEMBER = {"username": "sam", "display_name": "Sam", "is_admin": "false",
              "auth_method": "plex", "plex_account_id": "1002", "avatar_url": ""}

    def setUp(self):
        from fastapi.testclient import TestClient
        from app import pages
        from app.auth import session_manager
        from app.routers.branding import EMPTY_WIKI_HOOKS, build_branding
        self.pages, self.session_manager = pages, session_manager
        self.branding = build_branding({}, {}, None, dict(EMPTY_WIKI_HOOKS))
        for p in (mock.patch("app.routers.setup.is_setup_completed", return_value=True),
                  mock.patch.object(pages, "SessionLocal", helpers.make_sessionmaker())):
            p.start()
            self.addCleanup(p.stop)
        helpers.set_rate_limits(False)
        self.addCleanup(helpers.set_rate_limits, True)
        self.client = TestClient(app)
        self.client.cookies.set(settings.session_cookie_name, "test-session")

    def get(self, session, on=True, path="/player-test"):
        with mock.patch.object(self.session_manager, "get_session", mock.AsyncMock(return_value=session)), \
             mock.patch.object(self.pages, "load_context", return_value=(self.branding, {"netdata": False})), \
             mock.patch.object(pp, "player_on", mock.Mock(return_value=on)):
            return self.client.get(path, follow_redirects=False)

    def test_an_admin_gets_the_page_while_the_player_is_on(self):
        r = self.get(self.ADMIN)
        self.assertEqual(r.status_code, 200)
        self.assertIn('data-ws-module="/static/js/pages/player-test.js?v=', r.text)
        self.assertIn('data-page="player-test"', r.text)

    def test_404_for_anyone_who_is_not_an_admin(self):
        for who, session in (("member", self.MEMBER), ("signed out", None),
                             ("local non-admin", {"username": "x", "is_admin": "false", "auth_method": "simple"})):
            with self.subTest(who):
                r = self.get(session)
                self.assertEqual(r.status_code, 404)
                self.assertNotIn("player-test", r.text)

    def test_404_while_the_player_is_off_even_for_an_admin(self):
        for session in (self.ADMIN, self.MEMBER, None):
            with self.subTest(session=bool(session)):
                self.assertEqual(self.get(session, on=False).status_code, 404)

    def test_the_404_is_the_one_an_unknown_address_gets(self):
        unknown = self.get(None, path="/no-such-page-here")
        for session, on in ((self.MEMBER, True), (None, True), (self.ADMIN, False)):
            r = self.get(session, on=on)
            self.assertEqual((r.status_code, r.json()), (unknown.status_code, unknown.json()))

    def test_its_file_is_never_served_from_static(self):
        # T10H1: the router mounts whatever a page's #wsPage names, so the raw
        # file would be a working launcher for anyone. Only the route serves it:
        # under /static it is the 404 a missing file gets, for everyone, in
        # every spelling of its path the static files would have resolved.
        missing = self.get(None, path="/static/no-such-file.html")
        self.assertEqual(missing.status_code, 404)
        spellings = ("/static/player-test.html", "/static//player-test.html", "/static/./player-test.html",
                     "/static/js/../player-test.html", "/static/player-test.html?v=1",
                     "/static/player%2Dtest.html")
        for who, session in (("signed out", None), ("member", self.MEMBER), ("admin", self.ADMIN)):
            for path in spellings:
                with self.subTest(who=who, path=path):
                    r = self.get(session, path=path)
                    self.assertEqual((r.status_code, r.content), (404, missing.content))
        self.assertEqual(self.client.head("/static/player-test.html").status_code, 404)
        # The route still serves it to an admin.
        self.assertEqual(self.get(self.ADMIN).status_code, 200)

    def test_every_other_static_file_is_served_as_before(self):
        for path in ("/static/news.html", "/static/js/pages/player-test.js", "/static/css/app.css",
                     "/static/webservarr.svg"):
            with self.subTest(path):
                self.assertEqual(self.get(None, path=path).status_code, 200)

    def test_nothing_in_the_navigation_links_to_it(self):
        from app.settings_registry import PAGE_ADDRESSES
        self.assertNotIn("/player-test", PAGE_ADDRESSES.values())
        # No link to its address on it or on any other page an admin sees: in
        # the sidebar, the drawer or anywhere else ("/static/js/pages/
        # player-test.js", its own module, is not its address).
        for path in ("/player-test", "/", "/settings", "/news"):
            with self.subTest(path):
                r = self.get(self.ADMIN, path=path)
                self.assertEqual(r.status_code, 200)
                self.assertNotRegex(r.text, r"""["'(]/player-test""")


if __name__ == "__main__":
    unittest.main()
