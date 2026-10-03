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


def ago(days: float):
    """A naive UTC time `days` before now: rows seeded at fixed dates would
    fall to the 180-day log prune once the calendar reaches them."""
    from datetime import datetime, timedelta, timezone
    return datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0) - timedelta(days=days)


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


# The stubbed library's work keys and narrators (plex_player.book_identity).
WORKS = {"200:1": "c3" * 16, "100:1": "d4" * 16}
NARRATORS = {"100:1": "Nora"}
TITLES = {"100:1": "Single Book", "200:1": "Parts Book"}
AUTHORS = {"100:1": "Ann Author", "200:1": "Bea Writer"}


async def fake_assert_in_library(key, track_key=None):
    pp.parse_key(key)
    if key not in LIBRARY:
        raise pp.NotInLibrary("Not in the audiobook library")
    if track_key is not None and track_key not in LIBRARY[key]:
        raise pp.NotInLibrary("Not in this book")
    return {"ratingKey": key.split(":")[0], "type": "album"}


async def fake_disc_in_library(key):
    """plex_player.disc_in_library at its boundary: the stubbed library holds the disc."""
    pp.parse_key(key)
    return key in LIBRARY


async def fake_checkin_book(key, track_key):
    """plex_player.checkin_book at its boundary: the book check, then the
    identity (None when the tracks read fails), through the module's own
    (patchable) assert_in_library and book_identity."""
    album = await pp.assert_in_library(key, track_key)
    try:
        return album, await pp.book_identity(key, album=album)
    except pp.PlayerUnavailable:
        return album, None


async def fake_book_identity(key, album=None):
    pp.parse_key(key)
    if key not in LIBRARY:
        raise pp.NotInLibrary("Not in the audiobook library")
    return {"work_key": WORKS.get(key), "author": AUTHORS.get(key), "narrator": NARRATORS.get(key),
            "duration_ms": sum(LIBRARY[key].values()) or None, "title": TITLES.get(key)}


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
        self.book_identity = mock.AsyncMock(side_effect=fake_book_identity)
        self.on = mock.Mock(return_value=True)
        patches = [
            mock.patch("app.routers.setup.is_setup_completed", return_value=True),
            mock.patch.object(pp, "player_on", self.on),
            mock.patch.object(pp, "assert_in_library", side_effect=fake_assert_in_library),
            mock.patch.object(pp, "disc_in_library", side_effect=fake_disc_in_library),
            mock.patch.object(pp, "book_detail", side_effect=fake_book_detail),
            mock.patch.object(pp, "list_books", mock.AsyncMock(return_value=[dict(b) for b in BOOKS])),
            mock.patch.object(pp, "library_access", self.library_access),
            mock.patch.object(pp, "plex_position", self.plex_position),
            mock.patch.object(pp, "timeline", self.timeline),
            mock.patch.object(pp, "cover_image", self.cover_image),
            mock.patch.object(pp, "next_in_series", self.next_in_series),
            mock.patch.object(pp, "book_identity", self.book_identity),
            mock.patch.object(pp, "checkin_book", side_effect=fake_checkin_book),
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
              ("get", "/api/player/prefs"), ("put", "/api/player/prefs"), ("post", "/api/player/checkin"),
              ("get", "/api/player/orphans/200:1"), ("post", "/api/player/orphans/200:1/dismiss")]

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
                     "/api/player/cover/999:1", "/api/player/book/not-a-key", "/api/player/position/1:x",
                     "/api/player/orphans/999:1", "/api/player/orphans/not-a-key"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)
        for path in ("/api/player/orphans/999:1/dismiss", "/api/player/orphans/not-a-key/dismiss"):
            with self.subTest(path=path):
                self.assertEqual(self.client.post(path, headers={"Origin": ORIGIN}).status_code, 404)
        # A track from another book, and a book that is not in the library.
        self.assertEqual(self.checkin(track="101").status_code, 404)
        self.assertEqual(self.checkin(book="999:1").status_code, 404)
        self.assertEqual(self.checkin(book="junk").status_code, 404)
        self.assertEqual(self.db.query(ListeningPosition).count(), 0)
        self.timeline.assert_not_awaited()

    def test_503_when_plex_is_unavailable(self):
        down = mock.AsyncMock(side_effect=pp.PlayerUnavailable("Plex is unavailable"))
        with mock.patch.object(pp, "assert_in_library", down):
            for path in ("/api/player/position/200:1", "/api/player/history/200:1", "/api/player/orphans/200:1"):
                self.assertEqual(self.client.get(path).status_code, 503, path)
            self.assertEqual(self.client.post("/api/player/orphans/200:1/dismiss",
                                              headers={"Origin": ORIGIN}).status_code, 503)
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
        # The page session that saved it: a page tells its own saves from another's.
        self.assertEqual(body["web"]["psid"], "psid-a")
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

    def test_position_says_when_plex_could_not_be_read(self):
        # A failed read is not "Plex holds no place": the player's re-read
        # before a late answer to a Plex app's question must tell them apart.
        self.checkin()
        for exc in (pp.PlayerUnavailable("down"), pp.TokenRejected("401"), pp.NoServerAccess("x")):
            self.plex_position.side_effect = exc
            body = self.client.get("/api/player/position/200:1").json()
            self.assertIsNone(body["plex"])
            self.assertIs(body["plex_error"], True)
        # The listener's state read answered with a 404 or an odd shape:
        # plex_position(strict=True) raises PlexStateUnreadable, so /position
        # flags it too (T4R1), rather than reading it as "no place".
        async def strict_unreadable(session, key, session_id=None, strict=False):
            if strict:
                raise pp.PlexStateUnreadable("odd")
            return None
        self.plex_position.side_effect = strict_unreadable
        body = self.client.get("/api/player/position/200:1").json()
        self.assertIsNone(body["plex"])
        self.assertIs(body["plex_error"], True)
        self.assertIs(self.plex_position.await_args.kwargs.get("strict"), True)
        # Read, with no place (or only an echo of ours): no flag at all.
        self.plex_position.side_effect = None
        self.plex_position.return_value = None
        body = self.client.get("/api/player/position/200:1").json()
        self.assertNotIn("plex_error", body)
        self.assertEqual(set(body), {"web", "plex", "now"})

    def test_history_is_newest_first(self):
        self.checkin(seq=1, offset_ms=1_000, event="play")
        self.checkin(seq=2, offset_ms=2_000, event="pause")
        body = self.client.get("/api/player/history/200:1").json()
        entries = body["entries"]
        self.assertIsNone(body["next_before"])
        self.assertEqual([e["offset_ms"] for e in entries], [2_000, 1_000])
        self.assertEqual(set(entries[0]), {"track", "offset_ms", "device", "device_id", "event", "at", "book_key",
                                           "book_ms", "book_duration_ms", "chapter_label"})

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
        self.base = base = ago(29)
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
        from datetime import timedelta
        self.fill()
        body = self.client.get("/api/player/history/200:1").json()
        self.assertEqual(len(body["entries"]), 500)
        self.assertIsNotNone(body["next_before"])
        # An entry's own "at" as a bare instant: every row strictly older.
        r = self.client.get("/api/player/history/200:1", params={
            "before": (self.base + timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")})
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


class BookTime(PlayerApiBase):
    """Spec 2.5: a check-in carries the place in book time and that copy's
    chapter name; the server adds the book's length, work key and narrator
    from its own read of the album."""

    def test_they_are_stored_on_the_position_and_the_log(self):
        r = self.checkin(book_ms=305_000, chapter_label="Part 2 of 3")
        self.assertEqual(r.status_code, 200, r.text)
        row = self.db.query(ListeningPosition).one()
        self.assertEqual((row.book_ms, row.chapter_label, row.book_duration_ms, row.work_key, row.narrator),
                         (305_000, "Part 2 of 3", 600_000, WORKS["200:1"], None))
        log = self.db.query(ListeningLog).one()
        self.assertEqual((log.book_ms, log.chapter_label, log.book_duration_ms, log.work_key),
                         (305_000, "Part 2 of 3", 600_000, WORKS["200:1"]))
        web = self.position()
        self.assertEqual({k: web[k] for k in ("book_ms", "book_duration_ms", "chapter_label", "narrator")},
                         {"book_ms": 305_000, "book_duration_ms": 600_000, "chapter_label": "Part 2 of 3",
                          "narrator": None})
        self.assertNotIn("linked_from", web)
        entry = self.client.get("/api/player/history/200:1").json()["entries"][0]
        self.assertEqual({k: entry[k] for k in ("book_key", "book_ms", "book_duration_ms", "chapter_label")},
                         {"book_key": "200:1", "book_ms": 305_000, "book_duration_ms": 600_000,
                          "chapter_label": "Part 2 of 3"})
        self.checkin(book="100:1", track="101", duration_ms=1_000_000, psid="psid-b")
        self.assertEqual(self.position("100:1")["narrator"], "Nora")

    def test_the_books_title_is_kept_and_shown(self):
        # Ruling (a): the title the library shows is stored with the place
        # (not in the log) and /position gives it; a failed identity read
        # keeps the one the row has.
        self.assertEqual(self.checkin(book_ms=1_000).status_code, 200)
        self.assertEqual(self.db.query(ListeningPosition).one().book_title, "Parts Book")
        self.assertEqual(self.position()["book_title"], "Parts Book")
        self.book_identity.side_effect = pp.PlayerUnavailable("down")
        self.assertEqual(self.checkin(seq=2, book_ms=2_000).status_code, 200)
        self.assertEqual(self.position()["book_title"], "Parts Book")
        self.assertFalse(hasattr(ListeningLog, "book_title"))

    def test_book_ms_past_the_books_length_is_clamped(self):
        self.checkin(book_ms=900_000)
        self.assertEqual(self.position()["book_ms"], 600_000)

    def test_book_identity_gets_the_album_the_check_already_read(self):
        self.checkin()
        self.book_identity.assert_awaited_once()
        args, kwargs = self.book_identity.await_args
        self.assertEqual(args, ("200:1",))
        self.assertEqual(kwargs, {"album": {"ratingKey": "200", "type": "album"}})

    def test_plex_failing_on_the_identity_read_still_saves(self):
        self.book_identity.side_effect = pp.PlayerUnavailable("down")
        r = self.checkin(book_ms=10_000, chapter_label="Part 1 of 3")
        self.assertEqual(r.status_code, 200)
        row = self.db.query(ListeningPosition).one()
        self.assertEqual((row.book_ms, row.chapter_label, row.book_duration_ms, row.work_key, row.narrator),
                         (10_000, "Part 1 of 3", None, None, None))
        self.book_identity.side_effect = pp.NotInLibrary("gone")
        self.assertEqual(self.checkin(seq=2).status_code, 404)

    def test_a_failed_identity_read_keeps_the_rows_server_fields(self):
        # T1B3: the row keeps the length, work key and narrator it had.
        self.checkin(book="100:1", track="101", duration_ms=1_000_000, seq=1)
        self.book_identity.side_effect = pp.PlayerUnavailable("down")
        self.assertEqual(self.checkin(book="100:1", track="101", duration_ms=1_000_000, seq=2,
                                      book_ms=7_000).status_code, 200)
        row = self.db.query(ListeningPosition).one()
        self.db.refresh(row)
        self.assertEqual((row.book_ms, row.book_duration_ms, row.work_key, row.narrator),
                         (7_000, 1_000_000, WORKS["100:1"], "Nora"))

    def test_they_are_optional(self):
        self.assertEqual(self.checkin().status_code, 200)
        web = self.position()
        self.assertEqual((web["book_ms"], web["chapter_label"]), (None, None))
        self.assertEqual(self.checkin(seq=2, book_ms=None, chapter_label=None).status_code, 200)

    def test_validation(self):
        for fields in ({"book_ms": -1}, {"book_ms": 10 ** 9 + 1}, {"book_ms": 1.5}, {"book_ms": 1.0},
                       {"book_ms": "5000"}, {"book_ms": True}, {"chapter_label": "c" * 201},
                       {"chapter_label": 5}, {"chapter_label": ["x"]}):
            with self.subTest(fields=fields):
                self.assertEqual(self.checkin(**fields).status_code, 422)
        body = json.dumps({"book": "200:1", "track": "202", "offset_ms": 1, "duration_ms": 2, "event": "play",
                           "psid": "p", "seq": 1, "chapter_label": "Chapter \ud800"})
        self.assertIn("\\ud800", body)
        r = self.client.post("/api/player/checkin", content=body.encode(),
                             headers={"Origin": ORIGIN, "Content-Type": "application/json"})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(self.db.query(ListeningPosition).count(), 0)
        self.timeline.assert_not_awaited()
        # The edges are taken; an empty chapter name is stored as null.
        self.assertEqual(self.checkin(book_ms=0, chapter_label="").status_code, 200)
        self.assertIsNone(self.db.query(ListeningPosition).one().chapter_label)
        self.assertEqual(self.checkin(seq=2, book_ms=10 ** 9, chapter_label="c" * 200).status_code, 200)


class EarlierCopies(PlayerApiBase):
    """Spec 2.5 s4: a book re-added as a new album (a new key) inherits the
    listener's place and history in its earlier copy, only while the listener
    has no row of their own for the new key and only when the earlier copy's
    album is gone from the library. Editions side by side (Review Focus 4)
    never link."""

    NEW = "400:1"       # the re-added copy
    GONE = "300:1"      # the earlier copy, no longer in the library
    WORK = "e5" * 16

    def setUp(self):
        super().setUp()
        for p in (mock.patch.dict(LIBRARY, {self.NEW: {"401": 500_000}}),
                  mock.patch.dict(WORKS, {self.NEW: self.WORK})):
            p.start()
            self.addCleanup(p.stop)

    def seed(self, book, identity="plex:1001", work_key=WORK, offset=1_234, at=None, logs=2):
        from datetime import datetime
        at = at or ago(10)
        self.db.add(ListeningPosition(identity=identity, book_key=book, track_key="301", offset_ms=offset,
                                      duration_ms=400_000, updated_at=at, device="Old phone", source="web",
                                      psid="old", seq=3, book_ms=offset + 400_000, book_duration_ms=900_000,
                                      chapter_label="Chapter 4", work_key=work_key, narrator="Tamsin Ashby",
                                      book_title="Tide Mill (Unabridged)"))
        for n in range(logs):
            self.db.add(ListeningLog(identity=identity, book_key=book, track_key="301", offset_ms=offset - n,
                                     device="Old phone", event="checkin", at=at, book_ms=offset + 400_000 - n,
                                     book_duration_ms=900_000, chapter_label="Chapter 4", work_key=work_key))
        self.db.commit()

    def history(self, key=NEW):
        r = self.client.get(f"/api/player/history/{key}")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["entries"]

    def test_a_copy_whose_album_is_gone_is_linked(self):
        self.seed(self.GONE)
        web = self.position(self.NEW)
        self.assertEqual(web["linked_from"], self.GONE)
        self.assertEqual((web["track"], web["offset_ms"], web["book_ms"], web["book_duration_ms"],
                          web["chapter_label"], web["narrator"], web["book_title"]),
                         ("301", 1_234, 401_234, 900_000, "Chapter 4", "Tamsin Ashby", "Tide Mill (Unabridged)"))
        entries = self.history()
        self.assertEqual([(e["book_key"], e.get("earlier_copy")) for e in entries],
                         [(self.GONE, True), (self.GONE, True)])
        # Nothing was written for the new key: the old place stays as it is.
        self.assertEqual(self.db.query(ListeningPosition).filter_by(book_key=self.NEW).count(), 0)

    def test_editions_side_by_side_are_never_linked(self):
        # The same work key under a book still in the library.
        self.seed("100:1")
        self.assertIsNone(self.position(self.NEW))
        self.assertEqual(self.history(), [])

    def test_a_gone_copy_older_than_one_still_there_is_found(self):
        from datetime import datetime
        self.seed("100:1", at=ago(5))           # newer, but side by side
        self.seed(self.GONE, at=ago(10), offset=777)
        web = self.position(self.NEW)
        self.assertEqual((web["linked_from"], web["offset_ms"]), (self.GONE, 777))
        self.assertEqual({e["book_key"] for e in self.history()}, {self.GONE})

    def test_another_identitys_rows_are_never_linked(self):
        self.seed(self.GONE, identity="plex:1002")
        self.assertIsNone(self.position(self.NEW))
        self.assertEqual(self.history(), [])
        self.as_user(B)
        self.assertEqual(self.position(self.NEW)["linked_from"], self.GONE)

    def test_a_row_of_their_own_for_the_new_key_means_no_link(self):
        self.seed(self.GONE)
        self.checkin(book=self.NEW, track="401", offset_ms=9_000, duration_ms=500_000)
        web = self.position(self.NEW)
        self.assertNotIn("linked_from", web)
        self.assertEqual((web["track"], web["offset_ms"]), ("401", 9_000))
        self.assertEqual([(e["book_key"], e.get("earlier_copy")) for e in self.history()], [(self.NEW, None)])

    def test_another_work_or_no_work_key_is_not_linked(self):
        self.seed(self.GONE, work_key="f6" * 16)
        self.seed("310:1", work_key=None)
        self.assertIsNone(self.position(self.NEW))
        self.assertEqual(self.history(), [])

    # --- The database is asked before Plex (point 3) ---

    def calls(self):
        return pp.assert_in_library.await_count, self.book_identity.await_count

    def test_no_work_keyed_row_elsewhere_costs_no_plex_read(self):
        self.seed(self.GONE, work_key=None)          # a row, but saved before work keys
        self.seed("310:1", identity="plex:1002")     # another listener's
        self.assertIsNone(self.position(self.NEW))
        # Only the book check every /position makes; no work-key read.
        self.assertEqual(self.calls(), (1, 0))
        self.history()
        self.assertEqual(self.calls(), (2, 0))

    def test_a_candidate_costs_the_tracks_read_with_the_album_reused(self):
        self.seed(self.GONE)
        self.assertEqual(self.position(self.NEW)["linked_from"], self.GONE)
        # The book check, then the gone copy's check; one work-key read, given
        # the album the book check read.
        self.assertEqual(self.calls(), (2, 1))
        self.assertEqual(self.book_identity.await_args.kwargs, {"album": {"ratingKey": "400", "type": "album"}})

    # --- The link is kept by the first save in the new copy (point 1) ---

    def save_new(self, **fields):
        body = dict(book=self.NEW, track="401", offset_ms=9_000, duration_ms=500_000, psid="new-page")
        body.update(fields)
        r = self.checkin(**body)
        self.assertEqual(r.status_code, 200, r.text)
        return self.db.query(ListeningPosition).filter_by(identity="plex:1001", book_key=self.NEW).one()

    def test_the_earlier_copys_history_stays_after_saving_in_the_new_copy(self):
        self.seed(self.GONE)
        self.assertEqual(self.position(self.NEW)["linked_from"], self.GONE)
        row = self.save_new(seq=1, base=None, linked_from=self.GONE)
        self.assertEqual(row.linked_from, self.GONE)
        # Later saves carry no link and keep it.
        row = self.save_new(seq=2, offset_ms=10_000)
        self.db.refresh(row)
        self.assertEqual(row.linked_from, self.GONE)
        # The book now resumes from its own row, and its history keeps the
        # earlier copy's entries, marked.
        web = self.position(self.NEW)
        self.assertNotIn("linked_from", web)
        self.assertEqual(web["offset_ms"], 10_000)
        entries = self.history()
        self.assertEqual([(e["book_key"], e.get("earlier_copy")) for e in entries],
                         [(self.NEW, None), (self.NEW, None), (self.GONE, True), (self.GONE, True)])

    def test_a_forged_link_is_ignored(self):
        self.seed("310:1", identity="plex:1002")          # another listener's copy, gone
        self.seed(self.GONE, work_key="f6" * 16)           # own copy, gone, another work
        self.seed("100:1")                                 # own copy, same work, still in the library
        for seq, forged in enumerate(("310:1", self.GONE, "100:1", self.NEW, "999:1"), start=1):
            with self.subTest(linked_from=forged):
                row = self.save_new(seq=seq, linked_from=forged)
                self.db.refresh(row)
                self.assertIsNone(row.linked_from)
        self.assertEqual({e["book_key"] for e in self.history()}, {self.NEW})
        # Not a book key at all: refused like any other bad field.
        for bad in ("junk", "310", "310:1:1", 310):
            with self.subTest(bad=bad):
                self.assertEqual(self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="new-page",
                                              seq=99, linked_from=bad).status_code, 422)

    def test_a_link_plex_cannot_confirm_is_not_kept(self):
        self.seed(self.GONE)

        async def check(key, track_key=None):
            if key == self.GONE:
                raise pp.PlayerUnavailable("down")
            return await fake_assert_in_library(key, track_key)
        with mock.patch.object(pp, "assert_in_library", side_effect=check):
            row = self.save_new(seq=1, linked_from=self.GONE)
        self.assertIsNone(row.linked_from)
        self.book_identity.side_effect = pp.PlayerUnavailable("down")
        row = self.save_new(seq=2, linked_from=self.GONE)
        self.db.refresh(row)
        self.assertIsNone(row.linked_from)

    def test_plex_failing_during_the_lookup_is_503_not_a_null_place(self):
        # T1S1: a null would open the book at 0:00 and the first save would
        # lose the link for good; 503 is the player's Retry.
        self.seed(self.GONE)
        self.book_identity.side_effect = pp.PlayerUnavailable("down")
        for path in (f"/api/player/position/{self.NEW}", f"/api/player/history/{self.NEW}"):
            with self.subTest(path=path, failing="work key"):
                self.assertEqual(self.client.get(path).status_code, 503)
        self.book_identity.side_effect = fake_book_identity

        async def check(key, track_key=None):
            if key == self.GONE:
                raise pp.PlayerUnavailable("down")
            return await fake_assert_in_library(key, track_key)
        with mock.patch.object(pp, "assert_in_library", side_effect=check):
            for path in (f"/api/player/position/{self.NEW}", f"/api/player/history/{self.NEW}"):
                with self.subTest(path=path, failing="the earlier copy's check"):
                    self.assertEqual(self.client.get(path).status_code, 503)
        self.assertEqual(self.db.query(ListeningPosition).filter_by(book_key=self.NEW).count(), 0)
        # Once Plex answers, the link is there.
        self.assertEqual(self.position(self.NEW)["linked_from"], self.GONE)

    def test_a_listener_with_no_candidate_never_sees_a_503(self):
        self.book_identity.side_effect = pp.PlayerUnavailable("down")
        self.assertIsNone(self.position(self.NEW))

    # --- The exact album-level key is the pre-check (T1S5) ---

    def album_key(self, work_key):
        fake = mock.Mock(side_effect=lambda album: work_key if album and album.get("ratingKey") == "400" else None)
        p = mock.patch.object(pp, "album_work_key", fake)
        p.start()
        self.addCleanup(p.stop)

    def test_a_row_of_another_work_costs_one_tracks_read(self):
        # Spec 2.6 s3 (2.5 ledger T1S5): the album-level key finding no row
        # doesn't settle it, since the album may be the first disc of a box
        # set, keyed differently: the tracks are read once, and find nothing.
        self.album_key(self.WORK)
        self.seed(self.GONE, work_key="f6" * 16)
        self.assertIsNone(self.position(self.NEW))
        self.assertEqual(self.calls(), (1, 1))

    def test_a_disc_that_left_an_album_that_stayed_is_an_earlier_copy(self):
        # T2O2: presence is the book's (album and disc), not the album's.
        disc = "500:4"

        async def album_only(key, track_key=None):
            if key == disc:
                return {"ratingKey": "500", "type": "album"}      # the album is there, as the real check finds it
            return await fake_assert_in_library(key, track_key)
        self.seed(disc)
        with mock.patch.object(pp, "assert_in_library", side_effect=album_only):
            self.assertEqual(self.position(self.NEW)["linked_from"], disc)
            with mock.patch.dict(LIBRARY, {disc: {"501": 1_000}}):          # the disc is back
                self.assertIsNone(self.position(self.NEW))

    def test_the_first_disc_of_a_box_set_is_found_by_its_tracks(self):
        # Spec 2.6 s3 (2.5 ledger T1S5): the album-level key is the book's
        # only for an album of one book. The first disc of a re-added box set
        # has a key of its own, which the pre-check never matched, so its
        # place was never found. The tracks are read when the album-level
        # key finds nothing.
        self.album_key("a1" * 16)                 # what the album alone says: no row has it
        self.seed(self.GONE)                      # the row has the disc's key, which book_identity gives
        self.assertEqual(self.position(self.NEW)["linked_from"], self.GONE)
        self.assertEqual(self.calls(), (2, 1))

    def test_a_row_with_the_exact_key_is_confirmed_from_the_tracks(self):
        self.album_key(self.WORK)
        self.seed(self.GONE)
        self.assertEqual(self.position(self.NEW)["linked_from"], self.GONE)
        self.assertEqual(self.calls(), (2, 1))

    def test_a_later_disc_still_uses_the_tracks(self):
        self.album_key(self.WORK)
        with mock.patch.dict(LIBRARY, {"400:2": {"402": 1_000}}), mock.patch.dict(WORKS, {"400:2": self.WORK}):
            self.seed(self.GONE)
            self.assertEqual(self.position("400:2")["linked_from"], self.GONE)
        self.assertEqual(self.book_identity.await_count, 1)

    # --- The link is set whatever the save's outcome (T1S2) ---

    def test_a_save_that_is_not_stored_still_sets_the_link(self):
        self.seed(self.GONE)
        self.save_new(seq=5)                                      # e.g. a leave beacon without the link
        r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="new-page", seq=4,
                         linked_from=self.GONE)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"stored": False, "updated_at": r.json()["updated_at"], "linked": True})
        row = self.db.query(ListeningPosition).filter_by(identity="plex:1001", book_key=self.NEW).one()
        self.db.refresh(row)
        self.assertEqual(row.linked_from, self.GONE)

    def test_a_conflict_still_sets_the_link(self):
        self.seed(self.GONE)
        self.save_new(seq=1, psid="other-device")
        r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="this-device", seq=1,
                         linked_from=self.GONE)
        self.assertEqual(r.status_code, 409)
        self.assertIs(r.json()["linked"], True)
        row = self.db.query(ListeningPosition).filter_by(identity="plex:1001", book_key=self.NEW).one()
        self.db.refresh(row)
        self.assertEqual(row.linked_from, self.GONE)

    def test_the_response_says_whether_the_link_was_kept(self):
        self.seed(self.GONE)
        self.seed("100:1")                                     # same work, still in the library
        r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="new-page", seq=1)
        self.assertNotIn("linked", r.json())                   # nothing claimed, nothing said
        r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="new-page", seq=2,
                         linked_from="100:1")
        self.assertIs(r.json()["linked"], False)
        # Plex can't confirm: null, send it again.

        async def check(key, track_key=None):
            if key == self.GONE:
                raise pp.PlayerUnavailable("down")
            return await fake_assert_in_library(key, track_key)
        with mock.patch.object(pp, "assert_in_library", side_effect=check):
            r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="new-page", seq=3,
                             linked_from=self.GONE)
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(r.json()["linked"])
        self.book_identity.side_effect = pp.PlayerUnavailable("down")
        r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="new-page", seq=4,
                         linked_from=self.GONE)
        self.assertIsNone(r.json()["linked"])
        self.book_identity.side_effect = fake_book_identity
        r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="new-page", seq=5,
                         linked_from=self.GONE)
        self.assertIs(r.json()["linked"], True)
        # Once set, another copy is not a link to make.
        self.seed("310:1")

        async def gone_too(key, track_key=None):
            if key == "310:1":
                raise pp.NotInLibrary("gone")
            return await fake_assert_in_library(key, track_key)
        with mock.patch.object(pp, "assert_in_library", side_effect=gone_too):
            r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="new-page", seq=6,
                             linked_from="310:1")
        self.assertIs(r.json()["linked"], False)

    def test_the_old_albums_check_runs_alongside_the_books_reads(self):
        import asyncio
        self.seed(self.GONE)
        seen = {"book": "idle", "overlap": False}

        async def slow_book(key, track_key):
            seen["book"] = "reading"
            await asyncio.sleep(0.05)
            seen["book"] = "done"
            return await fake_checkin_book(key, track_key)

        async def check(key, track_key=None):
            if key == self.GONE:
                seen["overlap"] = seen["book"] == "reading"
                await asyncio.sleep(0.05)
            return await fake_assert_in_library(key, track_key)
        with mock.patch.object(pp, "checkin_book", side_effect=slow_book), \
                mock.patch.object(pp, "assert_in_library", side_effect=check):
            r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="new-page", seq=1,
                             linked_from=self.GONE)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(seen["overlap"])

    # --- A place already carried into a copy still there (T5F1) ---

    THERE = "450:1"     # B: the copy A's place was carried into, still in the library

    def carried(self, book, from_key, identity="plex:1001", **seed):
        self.seed(book, identity=identity, **seed)
        row = self.db.query(ListeningPosition).filter_by(identity=identity, book_key=book).one()
        row.linked_from = from_key
        self.db.commit()

    def test_a_place_carried_into_a_copy_still_there_is_never_offered_again(self):
        # Spec 2.5 s2: A is gone, its place lives on in B (still in the
        # library); C, a side-by-side edition of B, must not take it too.
        from datetime import datetime
        with mock.patch.dict(LIBRARY, {self.THERE: {"451": 500_000}}), mock.patch.dict(WORKS, {self.THERE: self.WORK}):
            self.seed(self.GONE, at=ago(10))
            self.carried(self.THERE, self.GONE, at=ago(5))
            self.assertIsNone(self.position(self.NEW))
            self.assertEqual(self.history(), [])
            # Nor will the server store such a link.
            r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="new-page", seq=1,
                             linked_from=self.GONE)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertIs(r.json()["linked"], False)
            row = self.db.query(ListeningPosition).filter_by(identity="plex:1001", book_key=self.NEW).one()
            self.db.refresh(row)
            self.assertIsNone(row.linked_from)
            self.assertEqual({e["book_key"] for e in self.history()}, {self.NEW})
            # B keeps its own place and its link.
            self.assertNotIn("linked_from", self.position(self.THERE))
            self.assertEqual({e["book_key"] for e in self.history(self.THERE)}, {self.THERE, self.GONE})

    def test_a_copy_that_carried_it_and_went_too_passes_it_on(self):
        # A became B, B is gone too: a new C inherits B's place, and A's
        # history through B's link.
        from datetime import datetime
        self.seed(self.GONE, at=ago(10), offset=11, logs=1)
        self.carried("460:1", self.GONE, at=ago(5), offset=22, logs=1)
        web = self.position(self.NEW)
        self.assertEqual((web["linked_from"], web["offset_ms"]), ("460:1", 22))
        self.assertEqual([(e["book_key"], e.get("earlier_copy")) for e in self.history()],
                         [("460:1", True), (self.GONE, True)])
        row = self.save_new(seq=1, linked_from="460:1")
        self.assertEqual(row.linked_from, "460:1")
        self.assertEqual([e["book_key"] for e in self.history()], [self.NEW, "460:1", self.GONE])

    def test_a_copy_still_there_further_down_the_chain_still_counts(self):
        # A became B (gone), B became D (still there): A's place is D's.
        from datetime import datetime
        with mock.patch.dict(LIBRARY, {self.THERE: {"451": 500_000}}), mock.patch.dict(WORKS, {self.THERE: self.WORK}):
            self.seed(self.GONE, at=ago(10))
            self.carried("460:1", self.GONE, at=ago(8), work_key=None)
            self.carried(self.THERE, "460:1", at=ago(5), work_key=None)
            self.assertIsNone(self.position(self.NEW))
            r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="new-page", seq=1,
                             linked_from=self.GONE)
            self.assertIs(r.json()["linked"], False)

    def test_a_chain_past_the_bound_withholds_the_place(self):
        # Gone copies LINK_HOPS deep, then one still there: never merged
        # unchecked, and never more than LINK_HOPS album checks for the chain.
        from datetime import datetime
        from app.services import listening
        with mock.patch.dict(LIBRARY, {self.THERE: {"451": 500_000}}):
            self.seed(self.GONE, at=ago(29))
            keys = [f"{470 + n}:1" for n in range(listening.LINK_HOPS)] + [self.THERE]
            prev = self.GONE
            for n, k in enumerate(keys):
                self.carried(k, prev, at=ago(28 - n), work_key=None)
                prev = k
            self.assertIsNone(self.position(self.NEW))
            # The book check, A's check, then at most LINK_HOPS for the chain.
            self.assertLessEqual(pp.assert_in_library.await_count, 2 + listening.LINK_HOPS)
            # One link shorter, the chain ends gone: A's place is offered.
            last = self.db.query(ListeningPosition).filter_by(identity="plex:1001", book_key=self.THERE).one()
            self.db.delete(last)
            self.db.commit()
            self.assertEqual(self.position(self.NEW)["linked_from"], self.GONE)

    def test_another_listeners_copy_never_counts_as_carrying_it(self):
        with mock.patch.dict(LIBRARY, {self.THERE: {"451": 500_000}}), mock.patch.dict(WORKS, {self.THERE: self.WORK}):
            self.seed(self.GONE)
            self.carried(self.THERE, self.GONE, identity="plex:1002")
            self.assertEqual(self.position(self.NEW)["linked_from"], self.GONE)
            row = self.save_new(seq=1, linked_from=self.GONE)
            self.assertEqual(row.linked_from, self.GONE)

    def test_plex_failing_on_the_carried_copys_check_is_503_or_null(self):
        self.seed(self.GONE)
        self.carried("460:1", self.GONE, work_key=None)

        async def check(key, track_key=None):
            if key == "460:1":
                raise pp.PlayerUnavailable("down")
            return await fake_assert_in_library(key, track_key)
        with mock.patch.object(pp, "assert_in_library", side_effect=check):
            for path in (f"/api/player/position/{self.NEW}", f"/api/player/history/{self.NEW}"):
                with self.subTest(path=path):
                    self.assertEqual(self.client.get(path).status_code, 503)
            r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="new-page", seq=1,
                             linked_from=self.GONE)
            self.assertIsNone(r.json()["linked"])
        row = self.db.query(ListeningPosition).filter_by(identity="plex:1001", book_key=self.NEW).one()
        self.assertIsNone(row.linked_from)
        # Once Plex answers (460:1 is gone), A's place is the new copy's.
        self.assertIs(self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="new-page", seq=2,
                                   linked_from=self.GONE).json()["linked"], True)

    def test_a_link_resent_from_the_book_itself_still_holds(self):
        # The requesting book's own row already carries A: not a successor
        # that takes A away from it.
        self.seed(self.GONE)
        self.save_new(seq=1, linked_from=self.GONE)
        r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="new-page", seq=2,
                         linked_from=self.GONE)
        self.assertIs(r.json()["linked"], True)

    # --- History follows a chain of copies (T1S4) ---

    def test_history_follows_a_chain_of_copies(self):
        from datetime import datetime
        self.seed("290:1", at=ago(60), logs=1, offset=11)     # the first copy
        self.seed(self.GONE, offset=22, logs=1)
        gone = self.db.query(ListeningPosition).filter_by(identity="plex:1001", book_key=self.GONE).one()
        gone.linked_from = "290:1"
        self.db.commit()
        self.save_new(seq=1, linked_from=self.GONE)
        entries = self.history()
        self.assertEqual([(e["book_key"], e.get("earlier_copy")) for e in entries],
                         [(self.NEW, None), (self.GONE, True), ("290:1", True)])


class Claims(PlayerApiBase):
    """Spec 2.6 s4 (2.5 ledger T5R2): one successor per earlier copy. A
    confirm writes a claim on the earlier copy, pending when Plex can't
    verify it (linked: null), and a pending claim blocks a side-by-side
    edition exactly as a verified one does. A claim whose holder's album is
    gone, or whose holder's row was deleted or reset, blocks nothing, so
    chains (A to B to C) keep working."""

    NEW, GONE, WORK, THERE = EarlierCopies.NEW, EarlierCopies.GONE, EarlierCopies.WORK, EarlierCopies.THERE
    seed = EarlierCopies.seed
    carried = EarlierCopies.carried
    save_new = EarlierCopies.save_new
    history = EarlierCopies.history

    def setUp(self):
        super().setUp()
        # NEW (C) and THERE (B) are two editions side by side, both in the
        # library; GONE (A) is the earlier copy, gone.
        for p in (mock.patch.dict(LIBRARY, {self.NEW: {"401": 500_000}, self.THERE: {"451": 500_000}}),
                  mock.patch.dict(WORKS, {self.NEW: self.WORK, self.THERE: self.WORK})):
            p.start()
            self.addCleanup(p.stop)

    def claims(self, identity="plex:1001"):
        from app.models import ListeningClaim
        self.db.expire_all()
        return {(c.earlier_key, c.holder_key, c.state)
                for c in self.db.query(ListeningClaim).filter_by(identity=identity)}

    def link_of(self, book, identity="plex:1001"):
        self.db.expire_all()
        return self.db.query(ListeningPosition).filter_by(identity=identity, book_key=book).one().linked_from

    def down(self, key):
        """Plex can't check `key`'s album."""
        async def check(k, track_key=None):
            if k == key:
                raise pp.PlayerUnavailable("down")
            return await fake_assert_in_library(k, track_key)
        return mock.patch.object(pp, "assert_in_library", side_effect=check)

    def confirm(self, book, linked_from, seq=1, psid=None):
        track = next(iter(LIBRARY[book]))
        r = self.checkin(book=book, track=track, duration_ms=LIBRARY[book][track], psid=psid or "page-" + book,
                         seq=seq, linked_from=linked_from)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["linked"]

    def pending_in_b(self):
        self.seed(self.GONE)
        with self.down(self.GONE):
            self.assertIsNone(self.confirm(self.THERE, self.GONE))
        self.assertEqual(self.claims(), {(self.GONE, self.THERE, "pending")})
        self.assertIsNone(self.link_of(self.THERE))

    def test_a_pending_claim_blocks_a_side_by_side_edition(self):
        self.pending_in_b()
        # C, beside B: A's place is neither offered nor linked.
        self.assertIsNone(self.position(self.NEW))
        self.assertEqual(self.history(), [])
        self.assertIs(self.confirm(self.NEW, self.GONE), False)
        self.assertIsNone(self.link_of(self.NEW))
        self.assertEqual(self.claims(), {(self.GONE, self.THERE, "pending")})

    def test_a_pending_claim_is_verified_by_the_resend(self):
        self.pending_in_b()
        self.assertIs(self.confirm(self.THERE, self.GONE, seq=2), True)
        self.assertEqual(self.claims(), {(self.GONE, self.THERE, "verified")})
        self.assertEqual(self.link_of(self.THERE), self.GONE)
        self.assertEqual({e["book_key"] for e in self.history(self.THERE)}, {self.THERE, self.GONE})
        self.assertIsNone(self.position(self.NEW))

    def test_a_pending_claim_is_dropped_when_the_old_album_is_there_again(self):
        self.pending_in_b()
        with mock.patch.dict(LIBRARY, {self.GONE: {"301": 400_000}}):
            self.assertIs(self.confirm(self.THERE, self.GONE, seq=2), False)
        self.assertEqual(self.claims(), set())
        self.assertIsNone(self.link_of(self.THERE))

    def test_a_pending_claim_whose_book_is_unknown_yet_is_verified_later(self):
        # The book's own work key couldn't be read: pending, not refused.
        self.seed(self.GONE)
        self.book_identity.side_effect = pp.PlayerUnavailable("down")
        self.assertIsNone(self.confirm(self.THERE, self.GONE))
        self.assertEqual(self.claims(), {(self.GONE, self.THERE, "pending")})
        self.book_identity.side_effect = fake_book_identity
        self.assertIs(self.confirm(self.THERE, self.GONE, seq=2), True)
        self.assertEqual(self.claims(), {(self.GONE, self.THERE, "verified")})

    def test_a_chain_a_to_b_to_c(self):
        # A became B (verified), B is gone too: C inherits B's place, and
        # each copy holds the claim on the one before it.
        from datetime import datetime
        self.seed(self.GONE, at=ago(10), offset=11, logs=1)
        with mock.patch.dict(LIBRARY, {"460:1": {"461": 500_000}}), mock.patch.dict(WORKS, {"460:1": self.WORK}):
            self.assertIs(self.confirm("460:1", self.GONE), True)
        self.assertEqual(self.position(self.NEW)["linked_from"], "460:1")
        self.assertIs(self.confirm(self.NEW, "460:1"), True)
        self.assertEqual(self.claims(), {(self.GONE, "460:1", "verified"), ("460:1", self.NEW, "verified")})
        self.assertEqual([e["book_key"] for e in self.history()][-2:], ["460:1", self.GONE])

    def test_a_holder_that_went_too_does_not_block_and_its_claim_moves(self):
        # B claimed A (pending, its own work key unknown), then B went too.
        # C is offered A, and C's confirm takes the claim over.
        self.seed(self.GONE)
        with mock.patch.dict(LIBRARY, {"460:1": {"461": 500_000}}), mock.patch.dict(WORKS, {"460:1": None}):
            self.assertIsNone(self.confirm("460:1", self.GONE))
        self.assertEqual(self.claims(), {(self.GONE, "460:1", "pending")})
        self.assertEqual(self.position(self.NEW)["linked_from"], self.GONE)
        self.assertIs(self.confirm(self.NEW, self.GONE), True)
        self.assertEqual(self.claims(), {(self.GONE, self.NEW, "verified")})
        self.assertEqual(self.link_of(self.NEW), self.GONE)

    def test_a_verified_holder_that_went_too_passes_the_claim_on(self):
        from datetime import datetime
        from app.models import ListeningClaim
        self.seed(self.GONE)
        self.carried("460:1", self.GONE, work_key=None)       # B holds A's link, and B is gone
        self.db.add(ListeningClaim(identity="plex:1001", earlier_key=self.GONE, holder_key="460:1",
                                   state="verified", claimed_at=ago(9)))
        self.db.commit()
        self.assertEqual(self.position(self.NEW)["linked_from"], self.GONE)
        self.assertIs(self.confirm(self.NEW, self.GONE), True)
        self.assertEqual(self.claims(), {(self.GONE, self.NEW, "verified")})
        self.assertEqual(self.link_of("460:1"), self.GONE)      # B's history keeps its link

    def held_by_b(self):
        self.seed(self.GONE)
        self.assertIs(self.confirm(self.THERE, self.GONE), True)
        self.assertIsNone(self.position(self.NEW))

    def test_a_claim_is_released_when_its_holders_row_is_deleted(self):
        self.held_by_b()
        self.db.query(ListeningPosition).filter_by(identity="plex:1001", book_key=self.THERE).delete()
        self.db.commit()
        self.assertEqual(self.position(self.NEW)["linked_from"], self.GONE)
        self.assertIs(self.confirm(self.NEW, self.GONE), True)
        self.assertEqual(self.claims(), {(self.GONE, self.NEW, "verified")})

    def test_a_claim_is_released_when_its_holders_row_is_reset(self):
        self.held_by_b()
        self.db.query(ListeningPosition).filter_by(identity="plex:1001", book_key=self.THERE).update(
            {"linked_from": None})
        self.db.commit()
        self.assertEqual(self.position(self.NEW)["linked_from"], self.GONE)
        self.assertIs(self.confirm(self.NEW, self.GONE), True)
        self.assertEqual(self.claims(), {(self.GONE, self.NEW, "verified")})

    def test_claims_are_kept_apart_by_identity(self):
        # Another listener's pending claim on the same key blocks nothing of
        # this listener's, and the reverse.
        self.seed(self.GONE, identity="plex:1002")
        self.as_user(B)
        with self.down(self.GONE):
            self.assertIsNone(self.confirm(self.THERE, self.GONE))
        self.as_user(A)
        self.seed(self.GONE)
        self.assertEqual(self.position(self.NEW)["linked_from"], self.GONE)
        self.assertIs(self.confirm(self.NEW, self.GONE), True)
        self.assertEqual(self.claims(), {(self.GONE, self.NEW, "verified")})
        self.assertEqual(self.claims("plex:1002"), {(self.GONE, self.THERE, "pending")})
        self.as_user(B)
        self.assertIs(self.confirm(self.THERE, self.GONE, seq=2), True)
        self.assertEqual(self.claims("plex:1002"), {(self.GONE, self.THERE, "verified")})

    def commits_during(self, action):
        """What the database saw while `action` ran: "CLAIM" for each write
        to the claims table, "COMMIT" for each commit, in order."""
        from sqlalchemy import event
        engine = self.Session.kw["bind"]
        seen = []

        def statement(conn, cursor, sql, parameters, context, executemany):
            if "listening_claims" in sql and sql.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE")):
                seen.append("CLAIM")

        def commit(conn):
            seen.append("COMMIT")
        event.listen(engine, "before_cursor_execute", statement)
        event.listen(engine, "commit", commit)
        try:
            action()
        finally:
            event.remove(engine, "before_cursor_execute", statement)
            event.remove(engine, "commit", commit)
        return seen

    def test_the_claim_and_the_save_commit_together(self):
        # The claim is written in the check-in's own transaction (spec 2.6 s4),
        # verified or pending: exactly one COMMIT, after the claim's write.
        other_gone = "310:1"
        self.seed(self.GONE)
        self.seed(other_gone)
        warm = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="p", seq=1)
        self.assertEqual(warm.status_code, 200, warm.text)      # the daily housekeeping write goes here

        def confirm(book, earlier, track, duration, psid, seq):
            r = self.checkin(book=book, track=track, duration_ms=duration, psid=psid, seq=seq,
                             linked_from=earlier)
            self.assertEqual(r.status_code, 200, r.text)
            return r.json()["linked"]
        for kind, answer, run in (
                ("verified", True, lambda: confirm(self.NEW, self.GONE, "401", 500_000, "p", 2)),
                ("pending", None, lambda: confirm(self.THERE, other_gone, "451", 500_000, "q", 1))):
            with self.subTest(kind=kind):
                result = []
                if kind == "pending":
                    with self.down(other_gone):
                        seen = self.commits_during(lambda: result.append(run()))
                else:
                    seen = self.commits_during(lambda: result.append(run()))
                self.assertEqual(result, [answer])
                self.assertEqual(seen.count("COMMIT"), 1, seen)
                self.assertIn("CLAIM", seen[:seen.index("COMMIT")], seen)

    # --- T1P1: a pending claim settles on ANY check-in for its book -------------

    def plain_checkin(self, book, seq):
        """A check-in that carries no linked_from (the browser lost it, or
        the listener moved to another device)."""
        track = next(iter(LIBRARY[book]))
        r = self.checkin(book=book, track=track, duration_ms=LIBRARY[book][track], psid="other-device",
                         seq=seq, base=None)
        self.assertIn(r.status_code, (200, 409), r.text)
        return r

    def album_checks(self):
        """The album keys checked in the block (assert_in_library calls)."""
        calls = []

        async def check(k, track_key=None):
            calls.append(k)
            return await fake_assert_in_library(k, track_key)
        return calls, mock.patch.object(pp, "assert_in_library", side_effect=check)

    def test_a_pending_claim_is_verified_by_a_checkin_without_linked_from(self):
        self.pending_in_b()
        r = self.plain_checkin(self.THERE, 2)
        self.assertNotIn("linked", r.json())        # the client sent none: nothing to answer
        self.assertEqual(self.claims(), {(self.GONE, self.THERE, "verified")})
        self.assertEqual(self.link_of(self.THERE), self.GONE)
        self.assertEqual({e["book_key"] for e in self.history(self.THERE)}, {self.THERE, self.GONE})
        self.assertIsNone(self.position(self.NEW))      # still never offered to a side-by-side edition

    def test_a_pending_claim_is_dropped_by_a_checkin_without_linked_from_when_the_old_album_is_back(self):
        self.pending_in_b()
        with mock.patch.dict(LIBRARY, {self.GONE: {"301": 400_000}}):
            r = self.plain_checkin(self.THERE, 2)
        self.assertNotIn("linked", r.json())
        self.assertEqual(self.claims(), set())
        self.assertIsNone(self.link_of(self.THERE))

    def test_a_pending_claim_stays_pending_while_plex_cannot_say(self):
        self.pending_in_b()
        with self.down(self.GONE):
            r = self.plain_checkin(self.THERE, 2)
        self.assertNotIn("linked", r.json())
        self.assertEqual(self.claims(), {(self.GONE, self.THERE, "pending")})
        self.assertIsNone(self.link_of(self.THERE))
        self.assertIsNone(self.position(self.NEW))
        self.plain_checkin(self.THERE, 3)               # Plex is back: the next one settles it
        self.assertEqual(self.claims(), {(self.GONE, self.THERE, "verified")})

    def test_a_pending_claim_is_settled_even_when_the_checkin_is_a_conflict(self):
        self.pending_in_b()
        r = self.checkin(book=self.THERE, track="451", duration_ms=500_000, psid="third-device", seq=1,
                         base="2001-01-01T00:00:00.000Z")
        self.assertEqual(r.status_code, 409, r.text)
        self.assertNotIn("linked", r.json())
        self.assertEqual(self.claims(), {(self.GONE, self.THERE, "verified")})

    def test_a_pending_claim_costs_one_extra_album_check_per_checkin(self):
        self.pending_in_b()
        with self.down(self.GONE):
            self.plain_checkin(self.THERE, 2)           # still pending, still unreadable
        calls, patch = self.album_checks()
        with patch:
            self.plain_checkin(self.THERE, 3)
        self.assertEqual(calls.count(self.GONE), 1)     # the old album, once
        calls, patch = self.album_checks()
        with patch:
            self.plain_checkin(self.THERE, 4)           # verified now: nothing more to check
        self.assertNotIn(self.GONE, calls)

    def test_a_book_with_no_pending_claim_costs_no_extra_album_check(self):
        self.seed(self.GONE)
        calls, patch = self.album_checks()
        with patch:
            self.plain_checkin(self.THERE, 1)
        self.assertNotIn(self.GONE, calls)

    def test_a_checkin_that_sends_a_different_link_gets_only_that_links_answer(self):
        # The response's "linked" answers the link the request carried, never
        # the book's own pending claim.
        self.pending_in_b()
        r = self.checkin(book=self.THERE, track="451", duration_ms=500_000, psid="page-" + self.THERE, seq=2,
                         linked_from="999:1")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIs(r.json()["linked"], False)
        self.assertEqual(self.claims(), {(self.GONE, self.THERE, "verified")})

    def test_another_listeners_pending_claim_is_not_touched(self):
        self.seed(self.GONE, identity="plex:1002")
        self.as_user(B)
        with self.down(self.GONE):
            self.assertIsNone(self.confirm(self.THERE, self.GONE))
        self.as_user(A)
        self.seed(self.GONE)
        self.plain_checkin(self.THERE, 1)               # A has no claim: B's stays pending
        self.assertEqual(self.claims("plex:1002"), {(self.GONE, self.THERE, "pending")})
        self.assertEqual(self.claims(), set())

    # --- T1R1: a gone holder's claim is released only if A lives on nowhere else --

    X = "460:1"     # took A while pending, then left the library; Y (in the library) took X

    def x_then_y(self):
        """A (gone) -> X (pending claim, X gone since) -> Y (verified link to X,
        in the library). C is beside Y and its confirm of A arrives late."""
        self.seed(self.GONE)
        with mock.patch.dict(LIBRARY, {self.X: {"461": 500_000}}), mock.patch.dict(WORKS, {self.X: self.WORK}):
            with self.down(self.GONE):
                self.assertIsNone(self.confirm(self.X, self.GONE))
        self.assertIs(self.confirm(self.THERE, self.X), True)
        self.assertEqual(self.claims(), {(self.GONE, self.X, "pending"), (self.X, self.THERE, "verified")})

    def holder_kept(self, linked):
        self.assertIsNone(linked)
        self.assertEqual(self.claims(), {(self.GONE, self.X, "pending"), (self.X, self.THERE, "verified")})
        # Plex is fine again: A's place lives on in Y, so C is refused.
        self.assertIs(self.confirm(self.NEW, self.GONE, seq=3), False)
        self.assertIsNone(self.link_of(self.NEW))

    def test_the_holders_claim_is_kept_when_its_successor_cannot_be_read(self):
        self.x_then_y()
        with self.down(self.THERE):
            linked = self.confirm(self.NEW, self.GONE, seq=2)
        self.holder_kept(linked)

    def test_the_holders_claim_is_kept_when_the_old_album_cannot_be_read(self):
        self.x_then_y()
        with self.down(self.GONE):
            linked = self.confirm(self.NEW, self.GONE, seq=2)
        self.holder_kept(linked)

    def test_the_holders_claim_is_kept_when_the_new_books_own_key_cannot_be_read(self):
        self.x_then_y()
        self.book_identity.side_effect = pp.PlayerUnavailable("down")
        linked = self.confirm(self.NEW, self.GONE, seq=2)
        self.book_identity.side_effect = fake_book_identity
        self.holder_kept(linked)

    def test_the_holders_claim_is_kept_when_its_successor_is_in_the_library(self):
        # Control: Plex can say, so C is refused outright and the claim stays.
        self.x_then_y()
        self.assertIs(self.confirm(self.NEW, self.GONE, seq=2), False)
        self.assertEqual(self.claims(), {(self.GONE, self.X, "pending"), (self.X, self.THERE, "verified")})


class OrphanBase(PlayerApiBase):
    NEW = "400:1"       # the book opened: in the library, no place of the listener's own
    THERE = "450:1"     # another book in the library

    def setUp(self):
        super().setUp()
        self.author = "Cal Penn"
        for p in (mock.patch.dict(LIBRARY, {self.NEW: {"401": 500_000}, self.THERE: {"451": 500_000}}),
                  mock.patch.dict(WORKS, {self.NEW: "e5" * 16, self.THERE: "e5" * 16})):
            p.start()
            self.addCleanup(p.stop)
        self.rows = 0

        async def check(key, track_key=None):
            # As the real one: it knows albums, not discs (pp.disc_in_library does).
            pp.parse_key(key)
            if key.split(":")[0] not in {k.split(":")[0] for k in LIBRARY}:
                raise pp.NotInLibrary("Not in the audiobook library")
            album = {"ratingKey": key.split(":")[0], "type": "album"}
            return {**album, "parentTitle": self.author} if key == self.NEW else album
        p = mock.patch.object(pp, "assert_in_library", side_effect=check)
        self.assert_in_library = p.start()
        self.addCleanup(p.stop)

        async def listing():
            return [{"key": k, "title": k} for k in LIBRARY]
        p = mock.patch.object(pp, "list_books", side_effect=listing)
        self.list_books = p.start()
        self.addCleanup(p.stop)

    def row(self, book, identity="plex:1001", author="Cal Penn", book_ms=100_000, duration=1_000_000,
            end=False, event="checkin", **extra):
        """A position row of the listener's, each one a day newer than the last."""
        from datetime import datetime, timedelta
        self.rows += 1
        at = ago(29) + timedelta(days=self.rows)
        fields = dict(identity=identity, book_key=book, track_key="301", offset_ms=1_234, duration_ms=400_000,
                      updated_at=at, device="Old phone", source="web", psid="old", seq=3, book_ms=book_ms,
                      book_duration_ms=duration, chapter_label="Chapter 4", work_key="f6" * 16,
                      narrator="Tamsin Ashby", book_title=f"Title of {book}", author=author)
        fields.update(extra)
        self.db.add(ListeningPosition(**fields))
        self.db.add(ListeningLog(identity=identity, book_key=book, track_key="301", offset_ms=1_234,
                                 device="Old phone", event=event, at=at))
        if end:
            self.db.add(ListeningLog(identity=identity, book_key=book, track_key="301", offset_ms=1_234,
                                     device="Old phone", event="end", at=at))
        self.db.commit()
        return at

    def get(self, key=None):
        return self.client.get(f"/api/player/orphans/{key or self.NEW}")

    def listed(self, key=None):
        r = self.get(key)
        self.assertEqual(r.status_code, 200, r.text)
        return [o["key"] for o in r.json()["orphans"]]


class Orphans(OrphanBase):
    """Spec 2.6 s3: "Were you listening to one of these?". The listener's own
    places in books that are gone from the library, unfinished and carried
    forward by no copy still there, the same author first. Bounded: the
    newest 10 candidate rows and 10 album checks."""

    def test_a_place_in_a_book_that_left_the_library_is_listed_with_what_the_listener_needs(self):
        at = self.row("300:1")
        body = self.get().json()
        self.assertEqual(body["dismissed"], False)
        self.assertEqual(body["orphans"], [{
            "key": "300:1", "book_title": "Title of 300:1", "narrator": "Tamsin Ashby", "book_ms": 100_000,
            "book_duration_ms": 1_000_000, "chapter_label": "Chapter 4",
            "updated_at": at.strftime("%Y-%m-%dT%H:%M:%S.000Z"), "author_match": True}])

    def test_a_book_still_in_the_library_is_not_an_orphan(self):
        self.row("100:1")
        self.row(self.THERE)
        self.assertEqual(self.listed(), [])

    def test_nothing_is_listed_for_a_book_with_a_place_of_its_own(self):
        self.row("300:1")
        self.row(self.NEW)
        body = self.get().json()
        self.assertEqual((body["orphans"], body["dismissed"]), ([], False))

    def test_finished_means_97_percent_or_an_end_mark(self):
        self.row("301:1", book_ms=969, duration=1000)          # 96.9%: not finished
        self.row("302:1", book_ms=970, duration=1000)          # 97%: finished
        self.row("303:1", book_ms=1000, duration=1000)
        self.row("304:1", book_ms=10, duration=1000, end=True)  # an end mark wins over the time
        self.row("305:1", book_ms=None, duration=1000)         # no book time: still listed
        self.row("306:1", book_ms=999, duration=None)          # no length: still listed
        self.row("307:1", book_ms=999, duration=0)             # a zero length is no length
        self.row("308:1", book_ms=10, duration=1000, event="leave")   # other events are not an end
        self.assertEqual(sorted(self.listed()), ["301:1", "305:1", "306:1", "307:1", "308:1"])

    def test_an_end_mark_is_the_books_own_and_the_listeners_own(self):
        self.row("300:1")
        from datetime import datetime
        self.db.add(ListeningLog(identity="plex:1002", book_key="300:1", track_key="301", offset_ms=1,
                                 device="x", event="end", at=ago(28)))
        self.db.add(ListeningLog(identity="plex:1001", book_key="999:1", track_key="301", offset_ms=1,
                                 device="x", event="end", at=ago(28)))
        self.db.commit()
        self.assertEqual(self.listed(), ["300:1"])

    def test_the_same_author_comes_first_then_the_most_recent(self):
        self.row("301:1", author="Cal Penn")
        self.row("302:1", author="Someone Else")
        self.row("303:1", author=None)
        self.row("304:1", author="cal  penn.")
        self.row("305:1", author="Other Writer")
        body = self.get().json()["orphans"]
        self.assertEqual([(o["key"], o["author_match"]) for o in body],
                         [("304:1", True), ("301:1", True), ("305:1", False), ("303:1", False), ("302:1", False)])

    def test_with_no_author_to_match_it_is_by_recency(self):
        self.author = ""
        self.row("301:1")
        self.row("302:1", author="Someone Else")
        self.assertEqual([(o["key"], o["author_match"]) for o in self.get().json()["orphans"]],
                         [("302:1", False), ("301:1", False)])

    def test_only_ten_places_are_offered_the_newest_first(self):
        for n in range(12):
            self.row(f"{300 + n}:1")
        self.assertEqual(self.listed(), [f"{300 + n}:1" for n in range(11, 1, -1)])

    def test_exactly_one_library_listing_is_read_and_no_album_is_checked(self):
        for n in range(12):
            self.row(f"{300 + n}:1")
        self.row(self.THERE, linked_from="300:1")
        self.listed()
        self.assertEqual(self.list_books.await_count, 1)
        self.assertEqual(self.assert_in_library.await_count, 1)       # the book's own check, as every route makes

    def test_no_candidate_reads_no_listing(self):
        self.row("300:1", end=True)
        self.assertEqual(self.listed(), [])
        self.assertEqual(self.list_books.await_count, 0)

    def test_twelve_unfinished_books_still_in_the_library_do_not_hide_an_older_orphan(self):
        self.row("300:1")                                    # the orphan, older than all the rest
        there = {f"{600 + n}:1": {"1": 1} for n in range(12)}
        with mock.patch.dict(LIBRARY, there):
            for key in there:
                self.row(key)
            self.assertEqual(self.listed(), ["300:1"])
        self.assertEqual(self.list_books.await_count, 1)

    def test_finished_rows_do_not_hide_older_places(self):
        for n in range(12):
            self.row(f"{300 + n}:1", end=n >= 4)              # the 8 newest are finished
        self.assertEqual(sorted(self.listed()), [f"{300 + n}:1" for n in range(4)])

    def test_places_beyond_the_old_check_budget_are_offered(self):
        # Twelve places, each carried into a copy that is gone too (a finished
        # row, so not a candidate itself): every one is checked in memory, none
        # is dropped for want of an album check.
        for n in range(12):
            self.row(f"{300 + n}:1")
        for n in range(12):
            self.row(f"{500 + n}:1", linked_from=f"{300 + n}:1", end=True)
        found = self.listed()
        self.assertEqual(found, [f"{300 + n}:1" for n in range(11, 1, -1)])
        self.assertEqual(self.assert_in_library.await_count, 1)

    def test_a_successor_that_is_not_a_candidate_still_excludes_a_place_in_the_library(self):
        for n in range(12):
            self.row(f"{300 + n}:1")
        for n in range(12):
            self.row(f"{500 + n}:1", linked_from=f"{300 + n}:1", end=True)
        with mock.patch.dict(LIBRARY, {f"{500 + n}:1": {"1": 1} for n in range(12)}):
            self.assertEqual(self.listed(), [])
        self.assertEqual(self.list_books.await_count, 1)

    def test_a_successor_in_the_library_excludes_the_place_when_the_checks_allow(self):
        self.row("300:1")
        self.row("301:1")
        self.row(self.THERE, linked_from="300:1")
        self.assertEqual(self.listed(), ["301:1"])

    def test_a_pending_claim_excludes_the_place_too(self):
        from datetime import datetime
        from app.models import ListeningClaim
        self.row("300:1")
        self.row(self.THERE)
        self.db.add(ListeningClaim(identity="plex:1001", earlier_key="300:1", holder_key=self.THERE,
                                   state="pending", claimed_at=ago(10)))
        self.db.commit()
        self.assertEqual(self.listed(), [])
        self.assertEqual(self.get().status_code, 200)

    def test_a_verified_claim_excludes_the_place(self):
        from datetime import datetime
        from app.models import ListeningClaim
        self.row("300:1")
        self.row(self.THERE, linked_from="300:1")
        self.db.add(ListeningClaim(identity="plex:1001", earlier_key="300:1", holder_key=self.THERE,
                                   state="verified", claimed_at=ago(10)))
        self.db.commit()
        self.assertEqual(self.listed(), [])

    def test_a_chain_of_gone_copies_of_any_length_is_walked_in_full(self):
        # T2C2: the old walk stopped after 5 hops and took a longer chain as
        # carried forward, hiding the places at its start.
        for n in range(8):
            self.row(f"{300 + n}:1", linked_from=f"{299 + n}:1" if n else None)
        self.assertEqual(sorted(self.listed()), [f"{300 + n}:1" for n in range(8)])
        # The same chain ending in a copy still in the library: all but the last hold nothing.
        self.row(self.THERE, linked_from="307:1")
        self.assertEqual(self.listed(), [])

    def test_a_loop_of_copies_ends_and_offers_both(self):
        self.row("300:1", linked_from="301:1")
        self.row("301:1", linked_from="300:1")
        self.assertEqual(sorted(self.listed()), ["300:1", "301:1"])
        self.row(self.THERE, linked_from="301:1")
        self.assertEqual(self.listed(), [])

    def test_a_listener_who_finished_a_book_and_listened_again_is_still_offered_it(self):
        # T2O1: an end mark counts only while it is the latest event.
        book = dict(book="100:1", track="101", duration_ms=1_000_000, psid="pg", device="Phone")
        self.checkin(event="end", offset_ms=1_000_000, book_ms=1_000_000, seq=1, **book)
        saved = LIBRARY.pop("100:1")
        try:
            self.assertEqual(self.listed(), [])                       # finished
        finally:
            LIBRARY["100:1"] = saved
        self.checkin(event="play", offset_ms=0, book_ms=0, seq=2, **book)
        self.checkin(event="pause", offset_ms=400_000, book_ms=400_000, seq=3, **book)
        saved = LIBRARY.pop("100:1")
        try:
            self.assertEqual(self.listed(), ["100:1"])                # listened again
        finally:
            LIBRARY["100:1"] = saved

    def test_a_disc_that_left_a_box_set_that_stayed_is_gone(self):
        # T2O2: presence is the listing's book key (album and disc).
        self.row("500:4")
        with mock.patch.dict(LIBRARY, {"500:1": {"1": 1}, "500:2": {"2": 1}, "500:3": {"3": 1}}):
            self.assertEqual(self.listed(), ["500:4"])
        with mock.patch.dict(LIBRARY, {"500:4": {"4": 1}}):
            self.assertEqual(self.listed(), [])

    def test_a_successor_disc_that_left_does_not_carry_the_place(self):
        self.row("300:1")
        self.row("500:2", linked_from="300:1")
        with mock.patch.dict(LIBRARY, {"500:1": {"1": 1}}):
            self.assertEqual(sorted(self.listed()), ["300:1", "500:2"])
        with mock.patch.dict(LIBRARY, {"500:2": {"2": 1}}):
            self.assertEqual(self.listed(), [])

    def test_a_successor_that_is_gone_too_does_not_exclude_the_place(self):
        # A became B, B is gone as well: both are places a new copy may take.
        self.row("300:1")
        self.row("310:1", linked_from="300:1")
        self.assertEqual(sorted(self.listed()), ["300:1", "310:1"])

    def test_a_successor_further_down_the_chain_in_the_library_still_excludes(self):
        self.row("300:1")
        self.row("310:1", linked_from="300:1")
        self.row(self.THERE, linked_from="310:1")
        self.assertEqual(self.listed(), [])

    def test_the_opened_book_is_never_its_own_orphan(self):
        self.row("300:1")
        with mock.patch.dict(LIBRARY, {"300:1": {"301": 1}}):
            self.assertEqual(self.listed("300:1"), [])

    def test_another_listeners_places_and_successors_do_not_count(self):
        self.row("300:1", identity="plex:1002")
        self.row("301:1")
        self.row(self.THERE, identity="plex:1002", linked_from="301:1")      # theirs: no successor of mine
        self.assertEqual(self.listed(), ["301:1"])
        self.as_user(B)
        self.assertEqual(self.listed(), ["300:1"])

    def test_plex_failing_is_503_never_an_empty_list(self):
        self.row("300:1")
        self.row("301:1")
        down = mock.AsyncMock(side_effect=pp.PlayerUnavailable("down"))
        with mock.patch.object(pp, "assert_in_library", down):                 # the book's own check
            self.assertEqual(self.get().status_code, 503)
        with mock.patch.object(pp, "list_books", down):                        # the library listing
            self.assertEqual(self.get().status_code, 503)
        with mock.patch.object(pp, "list_books", mock.AsyncMock(side_effect=pp.PlayerOff("off"))):
            self.assertEqual(self.get().status_code, 404)
        self.assertEqual(sorted(self.listed()), ["300:1", "301:1"])

    def test_it_only_reads_the_database_for_the_listeners_own_rows(self):
        # T2M2: every query it makes on the listener's rows is bound to the
        # listener's identity as a parameter, and the candidate query is
        # limited to listening.ORPHAN_CANDIDATES.
        from sqlalchemy import event
        from app.services import listening
        seen = []

        def record(conn, cursor, statement, parameters, context, executemany):
            seen.append((statement, tuple(parameters) if not isinstance(parameters, dict) else tuple(parameters.values())))
        self.row("300:1")
        self.row("301:1", identity="plex:1002")
        self.row("302:1", linked_from="300:1")
        engine = self.Session.kw["bind"]
        event.listen(engine, "before_cursor_execute", record)
        self.addCleanup(event.remove, engine, "before_cursor_execute", record)
        self.assertEqual(sorted(self.listed()), ["300:1", "302:1"])
        reads = [(st, ps) for st, ps in seen if st.lstrip().upper().startswith("SELECT")
                 and ("listening_positions" in st or "listening_claims" in st or "listening_dismissals" in st)]
        self.assertTrue(reads)
        for statement, params in reads:
            self.assertIn("identity", statement)
            self.assertIn("plex:1001", params, statement)
            self.assertNotIn("plex:1002", params)
        candidates = [(st, ps) for st, ps in reads if "listening_log" in st and "listening_positions" in st]
        self.assertEqual(len(candidates), 1)
        self.assertIn("LIMIT", candidates[0][0].upper())
        self.assertIn(listening.ORPHAN_CANDIDATES, candidates[0][1])
        graph = [(st, ps) for st, ps in reads if "linked_from IS NOT NULL" in st]
        self.assertEqual(len(graph), 1)
        self.assertIn(listening.GRAPH_ROWS, graph[0][1])


class OrphanDismissal(OrphanBase):
    """"None of these" is kept on the server for the listener and the book."""

    def dismiss(self, key=None):
        return self.client.post(f"/api/player/orphans/{key or self.NEW}/dismiss", headers={"Origin": ORIGIN})

    def test_none_of_these_persists_for_that_book(self):
        self.row("300:1")
        self.assertEqual(self.listed(), ["300:1"])
        r = self.dismiss()
        self.assertEqual((r.status_code, r.json()), (200, {"dismissed": True}))
        body = self.get().json()
        self.assertEqual((body["orphans"], body["dismissed"]), ([], True))
        # On another device or tab: the same server answer.
        self.as_user(A)
        self.assertEqual(self.get().json()["dismissed"], True)

    def test_a_dismissal_without_places_needs_no_plex_lookup(self):
        self.row("300:1")
        self.dismiss()
        self.assert_in_library.reset_mock()
        self.list_books.reset_mock()
        self.assertEqual(self.get().json(), {"orphans": [], "dismissed": True})
        self.assertEqual(self.assert_in_library.await_count, 1)       # only the book's own check
        self.assertEqual(self.list_books.await_count, 0)              # T2M2: and no listing

    def test_it_is_per_book_key(self):
        self.row("300:1")
        self.dismiss()
        with mock.patch.dict(LIBRARY, {"410:1": {"411": 1_000}}):
            body = self.get("410:1").json()
        self.assertEqual((body["orphans"][0]["key"], body["dismissed"]), ("300:1", False))

    def test_it_is_per_listener(self):
        self.row("300:1", identity="plex:1002")
        self.dismiss()
        self.as_user(B)
        body = self.get().json()
        self.assertEqual((body["dismissed"], [o["key"] for o in body["orphans"]]), (False, ["300:1"]))

    def test_it_is_idempotent_and_leaves_one_row(self):
        from app.models import ListeningDismissal
        self.assertEqual(self.dismiss().status_code, 200)
        self.assertEqual(self.dismiss().status_code, 200)
        rows = self.db.query(ListeningDismissal).all()
        self.assertEqual([(r.identity, r.book_key) for r in rows], [("plex:1001", self.NEW)])

    def test_a_disc_that_is_not_in_the_listing_is_refused(self):
        # T2O4: the album is there, the disc is not.
        from app.models import ListeningDismissal
        for key in ("400:9", "400:999999", "400:2"):
            with self.subTest(key=key):
                self.assertEqual(self.dismiss(key).status_code, 404)
        self.assertEqual(self.db.query(ListeningDismissal).count(), 0)
        self.assertEqual(self.dismiss("400:1").status_code, 200)

    def test_a_listing_that_fails_is_503_and_stores_nothing(self):
        from app.models import ListeningDismissal
        with mock.patch.object(pp, "list_books", mock.AsyncMock(side_effect=pp.PlayerUnavailable("down"))):
            self.assertEqual(self.dismiss().status_code, 503)
        self.assertEqual(self.db.query(ListeningDismissal).count(), 0)

    def test_only_for_a_book_in_the_library_and_from_this_site(self):
        from app.models import ListeningDismissal
        self.assertEqual(self.dismiss("999:1").status_code, 404)
        self.assertEqual(self.dismiss("junk").status_code, 404)
        r = self.client.post(f"/api/player/orphans/{self.NEW}/dismiss", headers={"Origin": "https://evil.example"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.db.query(ListeningDismissal).count(), 0)

    def test_it_does_not_stop_the_book_being_saved_or_its_history(self):
        self.dismiss()
        r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="p-new", seq=1)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.client.get(f"/api/player/position/{self.NEW}").json()["web"]["track"], "401")


class ManualLinks(PlayerApiBase):
    """Spec 2.6 s3: a place the listener picked is claimed through the same
    claim path as an automatic link (uniqueness, pending, successors); it
    only skips the work-key match."""

    NEW, GONE, THERE = "400:1", "300:1", "450:1"
    seed = EarlierCopies.seed
    carried = EarlierCopies.carried
    history = EarlierCopies.history
    claims = Claims.claims
    link_of = Claims.link_of
    down = Claims.down

    def setUp(self):
        super().setUp()
        for p in (mock.patch.dict(LIBRARY, {self.NEW: {"401": 500_000}, self.THERE: {"451": 500_000}}),
                  mock.patch.dict(WORKS, {self.NEW: "e5" * 16, self.THERE: "e5" * 16})):
            p.start()
            self.addCleanup(p.stop)
        self.seq = 0

    def confirm(self, book=None, linked_from=None, manual=True, **extra):
        book = book or self.NEW
        track = next(iter(LIBRARY[book]))
        self.seq += 1
        fields = dict(book=book, track=track, duration_ms=LIBRARY[book][track], psid="page-" + book, seq=self.seq,
                      linked_from=linked_from or self.GONE)
        if manual:
            fields["link_manual"] = True
        fields.update(extra)
        r = self.checkin(**fields)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["linked"]

    def row_of(self, book, identity="plex:1001"):
        self.db.expire_all()
        return self.db.query(ListeningPosition).filter_by(identity=identity, book_key=book).one()

    def claim_manual(self):
        from app.models import ListeningClaim
        self.db.expire_all()
        return {c.earlier_key: c.manual for c in self.db.query(ListeningClaim).filter_by(identity="plex:1001")}

    OTHER_WORK = "f6" * 16

    def test_a_manual_link_skips_the_work_key_match_and_nothing_else(self):
        self.seed(self.GONE, work_key=self.OTHER_WORK)
        self.assertIs(self.confirm(manual=False), False)         # the work keys differ: not an automatic link
        self.assertIsNone(self.link_of(self.NEW))
        self.assertIs(self.confirm(), True)
        self.assertEqual(self.link_of(self.NEW), self.GONE)
        self.assertEqual(self.claims(), {(self.GONE, self.NEW, "verified")})

    def test_the_manual_flag_is_stored_on_the_claim_and_the_link(self):
        self.seed(self.GONE, work_key=self.OTHER_WORK)
        self.assertIs(self.confirm(), True)
        self.assertIs(self.row_of(self.NEW).link_manual, True)
        self.assertEqual(self.claim_manual(), {self.GONE: True})
        # History and the position carry on exactly as for an automatic link.
        self.assertEqual({e["book_key"] for e in self.history()}, {self.NEW, self.GONE})

    def test_an_automatic_link_is_not_flagged_manual(self):
        self.seed(self.GONE)
        self.assertIs(self.confirm(manual=False), True)
        self.assertIs(self.row_of(self.NEW).link_manual, False)
        self.assertEqual(self.claim_manual(), {self.GONE: False})

    def test_a_row_saved_before_work_keys_can_be_linked_by_hand(self):
        self.seed(self.GONE, work_key=None)
        self.assertIs(self.confirm(), True)

    def test_a_manual_link_needs_no_work_key_of_the_books_own(self):
        self.seed(self.GONE, work_key=self.OTHER_WORK)
        self.book_identity.side_effect = pp.PlayerUnavailable("down")
        self.assertIs(self.confirm(), True)

    def test_refused_while_the_old_album_is_in_the_library(self):
        self.seed(self.GONE, work_key=self.OTHER_WORK)
        with mock.patch.dict(LIBRARY, {self.GONE: {"301": 400_000}}):
            self.assertIs(self.confirm(), False)
        self.assertEqual(self.claims(), set())
        self.assertIsNone(self.link_of(self.NEW))

    def test_refused_when_another_copy_holds_the_claim(self):
        self.seed(self.GONE, work_key=self.OTHER_WORK)
        self.assertIs(self.confirm(self.THERE), True)            # B, in the library, claims A by hand
        self.assertIs(self.confirm(), False)                     # C may not
        self.assertEqual(self.claims(), {(self.GONE, self.THERE, "verified")})
        self.assertIsNone(self.link_of(self.NEW))

    def test_refused_when_another_copy_holds_a_pending_claim(self):
        self.seed(self.GONE, work_key=self.OTHER_WORK)
        with self.down(self.GONE):
            self.assertIsNone(self.confirm(self.THERE))
        self.assertEqual(self.claims(), {(self.GONE, self.THERE, "pending")})
        self.assertIs(self.confirm(), False)
        self.assertEqual(self.claims(), {(self.GONE, self.THERE, "pending")})

    def test_refused_when_the_place_was_carried_into_a_copy_still_there(self):
        self.seed(self.GONE, work_key=self.OTHER_WORK)
        self.carried(self.THERE, self.GONE, work_key=None)
        self.assertIs(self.confirm(), False)
        self.assertEqual(self.claims(), set())

    def test_a_copy_that_went_too_does_not_block_a_manual_link(self):
        # A became B by hand, B is gone: C may take B's place (a chain).
        self.seed(self.GONE, work_key=self.OTHER_WORK)
        self.carried("460:1", self.GONE, work_key=None)
        self.assertIs(self.confirm(linked_from="460:1"), True)
        self.assertEqual(self.link_of(self.NEW), "460:1")

    def test_refused_for_another_listeners_row(self):
        self.seed(self.GONE, identity="plex:1002", work_key=self.OTHER_WORK)
        self.assertIs(self.confirm(), False)
        self.assertEqual(self.claims(), set())
        self.assertEqual(self.claims("plex:1002"), set())
        self.assertIsNone(self.link_of(self.NEW))

    def test_refused_for_a_place_that_does_not_exist(self):
        self.assertIs(self.confirm(), False)
        self.assertEqual(self.claims(), set())

    def test_a_disc_that_left_an_album_that_stayed_can_be_linked_by_hand(self):
        disc = "500:4"

        async def album_only(key, track_key=None):
            if key == disc:
                return {"ratingKey": "500", "type": "album"}
            return await fake_assert_in_library(key, track_key)
        self.seed(disc, work_key=self.OTHER_WORK)
        with mock.patch.object(pp, "assert_in_library", side_effect=album_only):
            self.assertIs(self.confirm(linked_from=disc), True)
        self.assertEqual(self.link_of(self.NEW), disc)

    def test_a_manual_link_takes_over_a_claim_whose_holder_left_the_library(self):
        # T2M1: the holder is gone, so it blocks nothing: the claim moves to
        # the new book as a manual claim (and not as the holder's automatic one).
        from app.models import ListeningClaim
        self.seed(self.GONE, work_key=self.OTHER_WORK)
        self.seed("460:1", work_key=self.OTHER_WORK)               # an earlier link of GONE's place, gone too
        self.db.query(ListeningPosition).filter_by(book_key="460:1").update({"linked_from": self.GONE})
        self.db.add(ListeningClaim(identity="plex:1001", earlier_key=self.GONE, holder_key="460:1",
                                   state="verified", claimed_at=ago(9), manual=False))
        self.db.commit()
        self.assertIs(self.confirm(), True)
        self.assertEqual(self.claims(), {(self.GONE, self.NEW, "verified")})
        self.assertEqual(self.claim_manual(), {self.GONE: True})
        self.assertIs(self.row_of(self.NEW).link_manual, True)
        self.assertEqual(self.link_of(self.NEW), self.GONE)

    def test_a_manual_pending_claim_sent_again_without_the_flag_is_still_manual(self):
        # T2O3: the browser that lost the flag is not an automatic link.
        self.seed(self.GONE, work_key=self.OTHER_WORK)
        with self.down(self.GONE):
            self.assertIsNone(self.confirm())
        self.assertEqual(self.claims(), {(self.GONE, self.NEW, "pending")})
        self.assertIs(self.confirm(manual=False), True)
        self.assertEqual(self.claims(), {(self.GONE, self.NEW, "verified")})
        self.assertIs(self.row_of(self.NEW).link_manual, True)
        # And once verified, a resend still answers true.
        self.assertIs(self.confirm(manual=False), True)

    def test_an_automatic_pending_claim_sent_again_is_still_automatic(self):
        self.seed(self.GONE, work_key="e5" * 16)                    # the same work as NEW
        with self.down(self.GONE):
            self.assertIsNone(self.confirm(manual=False))
        self.assertIs(self.confirm(manual=False), True)
        self.assertEqual(self.claim_manual(), {self.GONE: False})
        self.assertIs(self.row_of(self.NEW).link_manual, False)

    def test_refused_when_it_would_make_a_loop(self):
        # A came from the book being linked: a link back would loop.
        self.seed(self.GONE, work_key=self.OTHER_WORK)
        self.db.query(ListeningPosition).filter_by(book_key=self.GONE).update({"linked_from": self.NEW})
        self.db.commit()
        self.assertIs(self.confirm(), False)
        self.assertIsNone(self.link_of(self.NEW))

    def test_a_book_already_linked_to_another_copy_keeps_that_link(self):
        self.seed(self.GONE, work_key=self.OTHER_WORK)
        self.seed("310:1")
        self.assertIs(self.confirm(linked_from="310:1"), True)
        self.assertIs(self.confirm(), False)
        self.assertEqual(self.link_of(self.NEW), "310:1")
        self.assertEqual(self.claims(), {("310:1", self.NEW, "verified")})

    def test_plex_unable_to_say_is_a_pending_manual_claim_that_verifies_on_any_check_in(self):
        self.seed(self.GONE, work_key=self.OTHER_WORK)
        with self.down(self.GONE):
            self.assertIsNone(self.confirm())
        self.assertEqual(self.claims(), {(self.GONE, self.NEW, "pending")})
        self.assertEqual(self.claim_manual(), {self.GONE: True})
        self.assertIsNone(self.link_of(self.NEW))
        # A later check-in with no link at all (the browser lost it) settles
        # it, as a manual link: no work-key match is asked of it.
        r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="page-" + self.NEW, seq=50)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.claims(), {(self.GONE, self.NEW, "verified")})
        self.assertEqual(self.link_of(self.NEW), self.GONE)
        self.assertIs(self.row_of(self.NEW).link_manual, True)

    def test_a_manual_pending_claim_is_dropped_when_the_old_album_is_back(self):
        self.seed(self.GONE, work_key=self.OTHER_WORK)
        with self.down(self.GONE):
            self.assertIsNone(self.confirm())
        with mock.patch.dict(LIBRARY, {self.GONE: {"301": 400_000}}):
            r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="page-" + self.NEW, seq=50)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.claims(), set())

    def test_two_copies_racing_for_one_place_by_hand_leave_one_holder(self):
        self.seed(self.GONE, work_key=self.OTHER_WORK)
        first, second = self.confirm(), self.confirm(self.THERE)
        self.assertEqual((first, second), (True, False))
        self.assertEqual(len(self.claims()), 1)

    def test_the_flag_must_be_true_or_false_and_needs_a_link(self):
        self.seed(self.GONE, work_key=self.OTHER_WORK)
        for fields in ({"link_manual": True}, {"link_manual": "yes", "linked_from": self.GONE},
                       {"link_manual": 1, "linked_from": self.GONE}, {"link_manual": None, "linked_from": self.GONE}):
            with self.subTest(fields=fields):
                r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="p", seq=1, **fields)
                self.assertEqual(r.status_code, 422)
        self.assertEqual(self.db.query(ListeningPosition).filter_by(book_key=self.NEW).count(), 0)

    def test_a_check_in_without_the_flag_is_unchanged(self):
        r = self.checkin(book=self.NEW, track="401", duration_ms=500_000, psid="p", seq=1)
        self.assertNotIn("linked", r.json())
        self.assertIsNone(self.row_of(self.NEW).link_manual)


class BookAuthor(PlayerApiBase):
    """The book's author is kept with the place (spec 2.6 s3), for the orphan
    lookup's author-first order."""

    def test_a_check_in_keeps_the_authors_name(self):
        self.checkin(book="100:1", track="101", duration_ms=1_000_000)
        row = self.db.query(ListeningPosition).filter_by(book_key="100:1").one()
        self.assertEqual(row.author, "Ann Author")

    def test_an_unreadable_author_leaves_what_the_row_had(self):
        self.checkin(book="100:1", track="101", duration_ms=1_000_000, seq=1)
        self.book_identity.side_effect = pp.PlayerUnavailable("down")
        self.checkin(book="100:1", track="101", duration_ms=1_000_000, seq=2)
        self.db.expire_all()
        self.assertEqual(self.db.query(ListeningPosition).filter_by(book_key="100:1").one().author, "Ann Author")


def _race_worker(db_path, book, barrier, out):
    """One uvicorn worker in TwoWorkersClaimOneCopy: its own process, engine
    and client on the shared database file. It confirms `book` as the
    successor of 300:1, after meeting the other worker at the save."""
    try:
        from sqlalchemy.orm import sessionmaker
        from app import database
        from app.services import listening
        engine = database.make_engine("sqlite:///" + db_path,
                                      connect_args={"check_same_thread": False, "timeout": 30})
        Session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
        real_save = listening.save_checkin

        def save(*args, **kwargs):
            # Both have verified the link (no successor yet) before either saves.
            barrier.wait()
            return real_save(*args, **kwargs)
        patches = [
            mock.patch("app.routers.setup.is_setup_completed", return_value=True),
            mock.patch.object(pp, "player_on", mock.Mock(return_value=True)),
            mock.patch.object(pp, "assert_in_library", side_effect=fake_assert_in_library),
            mock.patch.object(pp, "disc_in_library", side_effect=fake_disc_in_library),
            mock.patch.object(pp, "checkin_book", side_effect=fake_checkin_book),
            mock.patch.object(pp, "book_identity", mock.AsyncMock(side_effect=fake_book_identity)),
            mock.patch.object(pp, "timeline", mock.AsyncMock(return_value=None)),
            mock.patch.object(settings, "app_domain", "localhost"),
            mock.patch.object(settings, "app_scheme", "https"),
            mock.patch.dict(LIBRARY, {"400:1": {"401": 500_000}, "450:1": {"451": 500_000}}),
            mock.patch.dict(WORKS, {"400:1": "e5" * 16, "450:1": "e5" * 16}),
            mock.patch.object(listening, "save_checkin", save),
        ]
        for p in patches:
            p.start()
        client = helpers.api_client(Session, A)
        client.cookies.set(settings.session_cookie_name, "sid-race-" + book)
        track = next(iter(LIBRARY[book]))
        r = client.post("/api/player/checkin", headers={"Origin": ORIGIN}, json={
            "book": book, "track": track, "offset_ms": 9_000, "duration_ms": 500_000, "event": "checkin",
            "device": "Phone", "psid": "page-" + book, "seq": 1, "linked_from": "300:1"})
        out.put((book, r.status_code, r.json()))
    except BaseException as exc:   # reported to the parent, which fails the test
        out.put((book, "error", repr(exc)))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TwoWorkersClaimOneCopy(unittest.TestCase):
    """Spec 2.6 s4, the race (2.5 ledger T5R2a): two editions side by side
    confirm the same earlier copy at once, on the two uvicorn workers. Real
    processes on one SQLite file; both verify before either saves. Exactly
    one claim; the other gets linked: false with its place saved, unlinked."""

    def test_one_wins_the_other_is_refused_and_still_saved(self):
        import multiprocessing
        import os
        import queue
        import tempfile
        from datetime import datetime
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from app.database import Base
        from app.models import ListeningClaim

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = os.path.join(tmp.name, "race.db")
        engine = create_engine("sqlite:///" + path)
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(bind=engine)
        db = sessionmaker(bind=engine)()
        self.addCleanup(db.close)
        db.add(ListeningPosition(identity="plex:1001", book_key="300:1", track_key="301", offset_ms=1_234,
                                 duration_ms=400_000, updated_at=ago(10), device="Old phone",
                                 source="web", psid="old", seq=3, book_ms=401_234, book_duration_ms=900_000,
                                 work_key="e5" * 16))
        db.commit()

        ctx = multiprocessing.get_context("spawn")
        barrier = ctx.Barrier(2, timeout=120)
        out = ctx.Queue()
        workers = [ctx.Process(target=_race_worker, args=(path, book, barrier, out)) for book in ("400:1", "450:1")]
        for w in workers:
            w.start()
        results = []
        try:
            for _ in workers:
                results.append(out.get(timeout=180))
        except queue.Empty:
            self.fail(f"a worker never answered: {results}")
        finally:
            for w in workers:
                w.join(30)
                if w.is_alive():
                    w.kill()
        for book, status, body in results:
            self.assertEqual(status, 200, (book, body))
        linked = sorted((body["linked"], book) for book, _status, body in results)
        self.assertEqual([v for v, _book in linked], [False, True], results)
        winner, loser = linked[1][1], linked[0][1]
        claims = [(c.earlier_key, c.holder_key, c.state) for c in db.query(ListeningClaim).all()]
        self.assertEqual(claims, [("300:1", winner, "verified")])
        rows = {r.book_key: r for r in db.query(ListeningPosition).filter_by(identity="plex:1001")}
        self.assertEqual(rows[winner].linked_from, "300:1")
        self.assertIsNone(rows[loser].linked_from)
        self.assertEqual((rows[loser].offset_ms, rows[loser].psid), (9_000, "page-" + loser))
        for book, _status, body in results:
            self.assertIs(body["stored"], True, (book, body))


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

    def test_an_echo_left_out_is_no_plex_error(self):
        self.checkin(track="202", offset_ms=150_000, event="pause")
        self.plex_at("202", 150_000)
        body = self.client.get("/api/player/position/200:1").json()
        self.assertIsNone(body["plex"])
        self.assertNotIn("plex_error", body)

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

    def test_another_tab_of_the_same_browser_needs_the_rows_time(self):
        first = self.checkin(device_id=self.PHONE, psid="tab-1", offset_ms=20_000).json()
        second = self.checkin(device_id=self.PHONE, psid="tab-2", offset_ms=90_000, base=first["updated_at"])
        self.assertEqual(second.status_code, 200)
        self.timeline.reset_mock()
        # Tab 1, left paused, plays on from its old place: refused, nothing forwarded.
        r = self.checkin(device_id=self.PHONE, psid="tab-1", seq=2, offset_ms=20_250, base=first["updated_at"])
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["conflict"]["offset_ms"], 90_000)
        self.assertEqual(self.position()["offset_ms"], 90_000)
        self.timeline.assert_not_awaited()

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
                    "next_book": ("60 per 1 minute", "next"), "orphans": ("60 per 1 minute", "orphans"),
                    "dismiss_orphans": ("60 per 1 minute", "orphans-dismiss")}
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
