"""
The audiobook player's Plex bridge (app/integrations/plex_player.py).

Plex and plex.tv are stubbed at the httpx layer (httpx.MockTransport), so
every test drives the real request building and response parsing. The admin
config and the audiobook library setting are patched, so no test reads the
dev instance's settings, and the session write-back is a mock, so none
touches Redis.

A book is "<album ratingKey>:<disc>". The listener's own server access token
comes from plex.tv resources for the configured server (matched by machine
identifier) and is cached in the listener's Redis session for 6 hours. No
token is ever sent in a query string or written to a log line.
"""
import asyncio
import json
import logging
import unittest
from datetime import datetime, timezone
from unittest import mock
from urllib.parse import parse_qs, urlsplit

try:
    import httpx
    from app.integrations import plex_player as pp
    # Taken before any test patches httpx.AsyncClient.
    RealAsyncClient = httpx.AsyncClient
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

ADMIN_URL = "http://plex.test:32400"
ADMIN_TOKEN = "ADMIN-TOKEN-a1b2c3"
LISTENER_TOKEN = "LISTENER-TOKEN-d4e5f6"
SERVER_TOKEN = "SERVER-TOKEN-g7h8i9"
OTHER_SERVER_TOKEN = "OTHER-SERVER-TOKEN-j0k1"
TOKENS = (ADMIN_TOKEN, LISTENER_TOKEN, SERVER_TOKEN, OTHER_SERVER_TOKEN)
MACHINE = "machine-abc"
SECTION = "14"
SID = "sid-123"

LOCAL_URI = "https://10-0-0-3.hash1.plex.direct:32400"
REMOTE_URI = "https://203-0-113-9.hash1.plex.direct:32400"

RESOURCES = [
    {   # another server this listener can see: never chosen
        "name": "Elsewhere", "clientIdentifier": "machine-other", "provides": "server",
        "accessToken": OTHER_SERVER_TOKEN,
        "connections": [{"protocol": "https", "uri": "https://1-1-1-1.other.plex.direct:32400",
                         "port": 32400, "local": True, "relay": False}],
    },
    {   # a player, not a server, carrying the same id: never chosen
        "name": "Phone", "clientIdentifier": MACHINE, "provides": "player",
        "accessToken": "PLAYER-TOKEN", "connections": [],
    },
    {
        "name": "Home", "clientIdentifier": MACHINE, "provides": "server",
        "accessToken": SERVER_TOKEN,
        "connections": [
            {"protocol": "https", "uri": LOCAL_URI, "port": 32400, "local": True, "relay": False},
            {"protocol": "https", "uri": REMOTE_URI + "/", "port": 32400, "local": False, "relay": False},
            # plain http: excluded
            {"protocol": "http", "uri": "http://10.0.0.3:32400", "port": 32400, "local": True, "relay": False},
            # a relay: excluded
            {"protocol": "https", "uri": "https://relay-1.hash1.plex.direct:8443", "port": 8443,
             "local": False, "relay": True},
            # https but not plex.direct: excluded
            {"protocol": "https", "uri": "https://media.example.com:443", "port": 443,
             "local": False, "relay": False},
        ],
    },
]


def track(rk, album, disc, index, duration, folder, ext="mp3", title=None, **extra):
    t = {
        "ratingKey": str(rk), "type": "track", "parentRatingKey": str(album), "parentIndex": disc,
        "index": index, "duration": duration, "title": title or f"Track {index}",
        "grandparentTitle": ALBUMS[str(album)]["parentTitle"], "parentTitle": ALBUMS[str(album)]["title"],
        "thumb": f"/library/metadata/{album}/thumb/1700000000",
        "Media": [{"Part": [{"key": f"/library/parts/{rk}9/1700000000/file.{ext}",
                             "file": f"/data/Audiobooks/{folder}/{rk}.{ext}", "duration": duration}]}],
    }
    t.update(extra)
    return t


ALBUMS = {
    "100": {"ratingKey": "100", "type": "album", "title": "Single Book - Read by Nora Reed",
            "titleSort": "Single Book", "parentTitle": "Ann Author",
            "thumb": "/library/metadata/100/thumb/1700000000",
            "Collection": [{"tag": "The Saga - Read by Nora Reed"}]},
    "200": {"ratingKey": "200", "type": "album", "title": "Parts Book - Read by Pat Voice",
            "titleSort": "Parts Book", "parentTitle": "Bea Writer",
            "thumb": "/library/metadata/200/thumb/1700000000"},
    "300": {"ratingKey": "300", "type": "album", "title": "Copied Book (Narrated by Sam Lee)",
            "titleSort": "Copied Book", "parentTitle": "Bea Writer",
            "thumb": "/library/metadata/300/thumb/1700000000"},
    "400": {"ratingKey": "400", "type": "album", "title": "Long Series - Read by Kim Moss",
            "titleSort": "Long Series", "parentTitle": "Cal Penn",
            "thumb": "/library/metadata/400/thumb/1700000000"},
    "500": {"ratingKey": "500", "type": "album", "title": "Quiet Book",
            "titleSort": "Quiet Book", "parentTitle": "Ann Author",
            "thumb": "/library/metadata/500/thumb/1700000000"},
    "600": {"ratingKey": "600", "type": "album", "title": "Boxed Set",
            "titleSort": "Boxed Set", "parentTitle": "Cal Penn",
            "thumb": "/library/metadata/600/thumb/1700000000"},
    "700": {"ratingKey": "700", "type": "album", "title": "Two Halves - Read by Dee Lane",
            "titleSort": "Two Halves", "parentTitle": "Ann Author",
            "thumb": "/library/metadata/700/thumb/1700000000"},
    "800": {"ratingKey": "800", "type": "album", "title": "Mixed Bag - Read by Dee Lane",
            "titleSort": "Mixed Bag", "parentTitle": "Ann Author",
            "thumb": "/library/metadata/800/thumb/1700000000"},
}
# Not in the audiobook library.
OTHER_ALBUM = {"ratingKey": "900", "type": "album", "title": "Some Music", "parentTitle": "Band"}

TRACKS = {
    # Single file with three untitled chapters; the last chapter ends before
    # the file does.
    "100": [track(101, 100, 1, 1, 1_000_000, "A/Single", ext="m4b", title="Single Book")],
    # Three parts.
    "200": [track(201, 200, 1, 1, 100_000, "B/Parts"), track(202, 200, 1, 2, 200_000, "B/Parts"),
            track(203, 200, 1, 3, 300_000, "B/Parts")],
    # Two copies in two folders on one disc: a whole file and a longer
    # two-part copy. Only the longer copy is the book.
    "300": [track(301, 300, 1, 1, 509_000, "B/Copy one", ext="m4b"),
            track(302, 300, 1, 1, 260_000, "B/Copy two"), track(303, 300, 1, 2, 250_000, "B/Copy two")],
    # One album, two discs: two books titled from their tracks.
    "400": [track(401, 400, 1, 1, 50_000, "C/Long", title="First Tale, Part 01"),
            track(402, 400, 1, 2, 60_000, "C/Long", title="First Tale, Part 02"),
            track(411, 400, 2, 1, 70_000, "C/Long2", ext="m4b", title="Second Tale")],
    # A single file with no chapters at all.
    "500": [track(501, 500, 1, 1, 90_000, "A/Quiet", title="Quiet Book")],
    # One book spread over two folders (CD1, CD2) with no repeated track
    # number: every track stays.
    "600": [track(601, 600, 1, 1, 10_000, "C/Boxed/CD1"), track(602, 600, 1, 2, 10_000, "C/Boxed/CD1"),
            track(603, 600, 1, 3, 10_000, "C/Boxed/CD2"), track(604, 600, 1, 4, 10_000, "C/Boxed/CD2")],
    # Two m4b parts, each carrying its own chapters.
    "700": [track(701, 700, 1, 1, 100_000, "D/Halves", ext="m4b"),
            track(702, 700, 1, 2, 80_000, "D/Halves", ext="m4b")],
    # Mixed: the first part carries chapters, the second none.
    "800": [track(801, 800, 1, 1, 50_000, "D/Mixed", ext="m4b"),
            track(802, 800, 1, 2, 40_000, "D/Mixed")],
}

CHAPTERS = {
    "101": [
        {"index": 1, "startTimeOffset": 0, "endTimeOffset": 300_000},
        {"index": 2, "startTimeOffset": 300_000, "endTimeOffset": 700_000},
        {"index": 3, "startTimeOffset": 700_000, "endTimeOffset": 990_000},
    ],
    "411": [
        {"index": 1, "startTimeOffset": 0, "endTimeOffset": 30_000, "tag": "Opening\xa0Credits"},
        {"index": 2, "startTimeOffset": 30_000, "endTimeOffset": 69_000, "tag": "02"},
    ],
    "701": [
        {"index": 1, "startTimeOffset": 0, "endTimeOffset": 60_000, "tag": "Chapter 01 - The Start"},
        {"index": 2, "startTimeOffset": 60_000, "endTimeOffset": 100_030, "tag": "Chapter 02 - The Road"},
    ],
    "702": [
        # Plex's first chapter can start a moment in; the part still starts at 0.
        {"index": 1, "startTimeOffset": 20, "endTimeOffset": 30_000, "tag": "Chapter 03 - The Inn"},
        {"index": 2, "startTimeOffset": 30_000, "endTimeOffset": 50_000},
        {"index": 3, "startTimeOffset": 50_000, "endTimeOffset": 79_000, "tag": "Chapter 05 - Home"},
    ],
    "801": [
        {"index": 1, "startTimeOffset": 0, "endTimeOffset": 20_000, "tag": "Prologue"},
        {"index": 2, "startTimeOffset": 20_000, "endTimeOffset": 50_000},
    ],
}

# Formats as Plex reports them on the track's Media: the single file is the
# kind browsers cannot decode (E-AC3 in an .m4b); the parts are mp3; the
# quiet book's Media says nothing about its format.
TRACKS["100"][0]["Media"][0].update(container="mp4", audioCodec="eac3",
                                    audioProfile="Dolby Digital Plus + Dolby Atmos")
for _t in TRACKS["200"]:
    _t["Media"][0].update(container="mp3", audioCodec="mp3")
TRACKS["700"][0]["Media"][0].update(container="mp4", audioCodec="aac", audioProfile="lc")


class FakePlex:
    """Plex Media Server and plex.tv behind one httpx.MockTransport."""

    def __init__(self):
        self.calls = []
        self.resources = RESOURCES
        self.plextv_down = None       # None, "connect" or an HTTP status
        self.pms_down = None
        self.timeline_down = False
        self.reject_tokens = set()    # tokens the server answers 401 to
        self.identity = MACHINE
        # Per-token listening state: {token: {track rk: {viewOffset...}}}
        self.state = {}
        # Per-token readable library sections (the owner's view by default).
        self.sections = {}
        self.photo_type = "image/jpeg"
        # path -> a JSON body answered as is (200), for odd shapes.
        self.raw = {}

    def transport(self):
        return httpx.MockTransport(self.handle)

    def client_factory(self):
        real = RealAsyncClient

        def factory(*args, **kwargs):
            kwargs.pop("verify", None)
            return real(*args, transport=self.transport(), **kwargs)
        return factory

    @staticmethod
    def ok(body):
        return httpx.Response(200, json=body)

    @staticmethod
    def mc(**fields):
        return httpx.Response(200, json={"MediaContainer": fields})

    def handle(self, request):
        self.calls.append(request)
        url = request.url
        if url.host == "plex.tv":
            if self.plextv_down == "connect":
                raise httpx.ConnectError("plex.tv unreachable", request=request)
            if self.plextv_down:
                return httpx.Response(self.plextv_down, text="down")
            if url.path == "/api/v2/resources":
                return self.ok(self.resources)
            return httpx.Response(404)
        if self.pms_down == "connect":
            raise httpx.ConnectError("server unreachable", request=request)
        if self.pms_down:
            return httpx.Response(self.pms_down, text="down")
        token = request.headers.get("X-Plex-Token", "")
        if token in self.reject_tokens:
            return httpx.Response(401, text="unauthorized")
        path = url.path
        q = parse_qs(url.query.decode() if isinstance(url.query, bytes) else url.query)
        if path in self.raw:
            return httpx.Response(200, json=self.raw[path])
        if path == "/identity":
            return self.mc(machineIdentifier=self.identity)
        if path == "/library/sections":
            keys = self.sections.get(token, [SECTION, "5"])
            return self.mc(Directory=[{"key": k, "type": "artist", "title": f"Section {k}"} for k in keys])
        if path == "/photo/:/transcode":
            return httpx.Response(200, content=b"\x89PNG-or-JPEG", headers={"content-type": self.photo_type})
        if path == "/:/timeline":
            if self.timeline_down:
                raise httpx.ConnectError("timeline unreachable", request=request)
            return self.mc()
        if path == f"/library/sections/{SECTION}/all":
            if q.get("type") == ["9"]:
                return self.mc(Metadata=list(ALBUMS.values()), librarySectionID=int(SECTION))
            if q.get("type") == ["10"]:
                return self.mc(Metadata=[self._with_state(t, token) for ts in TRACKS.values() for t in ts])
        parts = path.strip("/").split("/")
        if parts[:2] == ["library", "metadata"] and len(parts) >= 3:
            rk = parts[2]
            if len(parts) == 4 and parts[3] == "children":
                if rk not in TRACKS:
                    return httpx.Response(404)
                return self.mc(Metadata=[self._with_state(t, token) for t in TRACKS[rk]],
                               librarySectionID=int(SECTION))
            if len(parts) == 3 and "," in rk:
                # Several tracks in one request, as Plex answers a
                # comma-joined list of rating keys.
                wanted = rk.split(",")
                found = []
                for ts in TRACKS.values():
                    for t in ts:
                        if t["ratingKey"] in wanted:
                            m = dict(t)
                            if q.get("includeChapters") == ["1"] and t["ratingKey"] in CHAPTERS:
                                m["Chapter"] = CHAPTERS[t["ratingKey"]]
                            found.append(m)
                return self.mc(Metadata=found, librarySectionID=int(SECTION))
            if len(parts) == 3:
                if rk in ALBUMS:
                    return self.mc(Metadata=[ALBUMS[rk]], librarySectionID=int(SECTION))
                if rk == "900":
                    return self.mc(Metadata=[OTHER_ALBUM], librarySectionID=5)
                for ts in TRACKS.values():
                    for t in ts:
                        if t["ratingKey"] == rk:
                            m = dict(t)
                            if q.get("includeChapters") == ["1"] and rk in CHAPTERS:
                                m["Chapter"] = CHAPTERS[rk]
                            return self.mc(Metadata=[m], librarySectionID=int(SECTION))
                if rk == "901":   # a track of the other section's album
                    return self.mc(Metadata=[{"ratingKey": "901", "type": "track", "parentRatingKey": "900",
                                              "parentIndex": 1}], librarySectionID=5)
                return httpx.Response(404)
        return httpx.Response(404)

    def _with_state(self, t, token):
        return {**t, **self.state.get(token, {}).get(t["ratingKey"], {})}

    def paths(self):
        return [c.url.path for c in self.calls]


def listener(**extra):
    s = {"user_id": "1001", "username": "sam", "auth_method": "plex", "plex_account_id": "1001",
         "plex_token": LISTENER_TOKEN}
    s.update(extra)
    return s


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class BridgeBase(unittest.TestCase):
    def setUp(self):
        self.plex = FakePlex()
        self.update_session = mock.AsyncMock()
        self.admin = {"url": ADMIN_URL, "token": ADMIN_TOKEN, "section": SECTION}
        patches = [
            mock.patch.object(pp.httpx, "AsyncClient", self.plex.client_factory()),
            mock.patch.object(pp, "_admin", lambda: dict(self.admin)),
            mock.patch.object(pp.session_manager, "update_session", self.update_session),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def run_async(self, coro):
        return asyncio.run(coro)

    def cached_blob(self):
        self.assertTrue(self.update_session.await_args_list, "the session was never written")
        sid, fields = self.update_session.await_args_list[-1].args
        self.assertEqual(sid, SID)
        return json.loads(fields[pp.SERVER_FIELD])

    def assert_no_token_in_urls(self):
        for c in self.plex.calls:
            for tok in TOKENS:
                self.assertNotIn(tok, str(c.url))


class ServerAccess(BridgeBase):
    def test_matches_the_configured_server_by_machine_id(self):
        out = self.run_async(pp.server_access(listener(), session_id=SID))
        self.assertEqual(out["token"], SERVER_TOKEN)
        # /identity asked with the admin token, plex.tv with the listener's own.
        ident = [c for c in self.plex.calls if c.url.path == "/identity"][0]
        self.assertEqual(ident.headers["X-Plex-Token"], ADMIN_TOKEN)
        res = [c for c in self.plex.calls if c.url.host == "plex.tv"][0]
        self.assertEqual(res.headers["X-Plex-Token"], LISTENER_TOKEN)
        self.assertTrue(res.headers.get("X-Plex-Client-Identifier"))
        self.assertEqual(res.headers.get("X-Plex-Product"), "WebServarr")
        self.assert_no_token_in_urls()

    def test_splits_local_and_remote_keeping_only_https_plex_direct(self):
        out = self.run_async(pp.server_access(listener(), session_id=SID))
        self.assertEqual(out["uris"], {"local": [LOCAL_URI], "remote": [REMOTE_URI]})

    def test_caches_in_the_session_for_six_hours(self):
        session = listener()
        with mock.patch.object(pp.time, "time", return_value=1_000_000.0):
            first = self.run_async(pp.server_access(session, session_id=SID))
        blob = self.cached_blob()
        self.assertEqual(blob["token"], SERVER_TOKEN)
        self.assertEqual(blob["at"], 1_000_000)
        # The next request carries the cached field from Redis: no Plex call.
        cached_session = listener(**{pp.SERVER_FIELD: json.dumps(blob)})
        calls_before = len(self.plex.calls)
        with mock.patch.object(pp.time, "time", return_value=1_000_000.0 + 6 * 3600 - 1):
            again = self.run_async(pp.server_access(cached_session, session_id=SID))
        self.assertEqual(again, first)
        self.assertEqual(len(self.plex.calls), calls_before)
        self.assertEqual(self.update_session.await_count, 1)
        # Six hours on, it is fetched again and written back.
        with mock.patch.object(pp.time, "time", return_value=1_000_000.0 + 6 * 3600 + 1):
            self.run_async(pp.server_access(cached_session, session_id=SID))
        self.assertGreater(len(self.plex.calls), calls_before)
        self.assertEqual(self.update_session.await_count, 2)

    def test_the_passed_session_dict_carries_the_cache_too(self):
        session = listener()
        self.run_async(pp.server_access(session, session_id=SID))
        n = len(self.plex.calls)
        self.run_async(pp.server_access(session, session_id=SID))
        self.assertEqual(len(self.plex.calls), n)

    def test_a_cache_from_another_server_address_is_not_used(self):
        self.run_async(pp.server_access(listener(), session_id=SID))
        blob = self.cached_blob()
        self.admin["url"] = "http://other.test:32400"
        n = len(self.plex.calls)
        self.run_async(pp.server_access(listener(**{pp.SERVER_FIELD: json.dumps(blob)}), session_id=SID))
        self.assertGreater(len(self.plex.calls), n)

    def cached_session(self):
        self.run_async(pp.server_access(listener(), session_id=SID))
        blob = self.cached_blob()
        self.update_session.reset_mock()
        return listener(**{pp.SERVER_FIELD: json.dumps(blob)})

    def test_force_refetches_and_rewrites_the_cache(self):
        session = self.cached_session()
        n = len(self.plex.calls)
        out = self.run_async(pp.server_access(session, session_id=SID, force=True))
        self.assertEqual(out["token"], SERVER_TOKEN)
        self.assertIn("/api/v2/resources", [c.url.path for c in self.plex.calls[n:]])
        self.assertEqual(self.cached_blob()["token"], SERVER_TOKEN)

    def test_a_401_on_the_cached_token_in_plex_position_drops_the_cache(self):
        session = self.cached_session()
        self.plex.reject_tokens = {SERVER_TOKEN}
        with self.assertRaises(pp.PlayerUnavailable):
            self.run_async(pp.plex_position(session, "200:1", session_id=SID))
        self.update_session.assert_awaited_once_with(SID, {pp.SERVER_FIELD: ""})
        self.assertNotIn(pp.SERVER_FIELD, session)
        # The next call asks plex.tv again.
        self.plex.reject_tokens = set()
        n = len(self.plex.calls)
        self.run_async(pp.server_access(listener(**{pp.SERVER_FIELD: ""}), session_id=SID))
        self.assertIn("/api/v2/resources", [c.url.path for c in self.plex.calls[n:]])

    def test_a_401_on_the_cached_token_in_timeline_drops_the_cache_and_never_raises(self):
        session = self.cached_session()
        self.plex.reject_tokens = {SERVER_TOKEN}
        self.assertIsNone(self.run_async(pp.timeline(session, "202", "playing", 1, 2, session_id=SID)))
        self.update_session.assert_awaited_once_with(SID, {pp.SERVER_FIELD: ""})
        self.assertNotIn(pp.SERVER_FIELD, session)

    def test_a_401_on_the_admin_token_leaves_the_listener_cache(self):
        session = self.cached_session()
        self.plex.reject_tokens = {ADMIN_TOKEN}
        with self.assertRaises(pp.PlayerUnavailable):
            self.run_async(pp.plex_position(session, "200:1", session_id=SID))
        self.update_session.assert_not_awaited()
        self.assertIn(pp.SERVER_FIELD, session)

    def test_a_failed_cache_drop_still_never_raises_from_timeline(self):
        session = self.cached_session()
        self.plex.reject_tokens = {SERVER_TOKEN}
        self.update_session.side_effect = ConnectionError("redis down")
        self.assertIsNone(self.run_async(pp.timeline(session, "202", "playing", 1, 2, session_id=SID)))

    def test_a_corrupt_cache_is_refetched(self):
        out = self.run_async(pp.server_access(listener(**{pp.SERVER_FIELD: "{not json"}), session_id=SID))
        self.assertEqual(out["token"], SERVER_TOKEN)

    def test_no_plex_token_is_no_server_access(self):
        with self.assertRaises(pp.NoServerAccess) as ctx:
            self.run_async(pp.server_access(listener(plex_token=""), session_id=SID))
        self.assertIsInstance(ctx.exception, pp.PlayerUnavailable)
        self.assertEqual(self.plex.calls, [])

    def test_server_not_shared_with_the_listener(self):
        self.plex.resources = [RESOURCES[0]]
        with self.assertRaises(pp.NoServerAccess):
            self.run_async(pp.server_access(listener(), session_id=SID))
        self.update_session.assert_not_awaited()

    def test_plex_tv_down_is_player_unavailable(self):
        for how in ("connect", 500, 401):
            with self.subTest(how=how):
                self.plex.plextv_down = how
                with self.assertRaises(pp.PlayerUnavailable):
                    self.run_async(pp.server_access(listener(), session_id=SID))
        self.update_session.assert_not_awaited()

    def test_server_down_is_player_unavailable(self):
        self.plex.pms_down = "connect"
        with self.assertRaises(pp.PlayerUnavailable):
            self.run_async(pp.server_access(listener(), session_id=SID))

    def test_no_usable_connection_is_player_unavailable(self):
        home = dict(RESOURCES[2], connections=[c for c in RESOURCES[2]["connections"]
                                               if c["relay"] or c["protocol"] == "http"])
        self.plex.resources = [home]
        with self.assertRaises(pp.PlayerUnavailable):
            self.run_async(pp.server_access(listener(), session_id=SID))

    def test_plex_not_configured_is_player_unavailable(self):
        self.admin["token"] = ""
        with self.assertRaises(pp.PlayerUnavailable):
            self.run_async(pp.server_access(listener(), session_id=SID))


class Books(BridgeBase):
    def books(self):
        return {b["key"]: b for b in self.run_async(pp.list_books())}

    def test_list_books_keys_and_shapes(self):
        books = self.books()
        self.assertEqual(set(books), {"100:1", "200:1", "300:1", "400:1", "400:2", "500:1", "600:1",
                                      "700:1", "800:1"})
        self.assertEqual(books["100:1"]["shape"], "single")
        self.assertEqual(books["200:1"]["shape"], "parts")
        self.assertEqual(books["300:1"]["shape"], "parts")
        self.assertEqual(books["400:2"]["shape"], "single")
        # Every request used the admin token in its header.
        for c in self.plex.calls:
            self.assertEqual(c.headers["X-Plex-Token"], ADMIN_TOKEN)
        self.assert_no_token_in_urls()

    def test_list_books_fields(self):
        b = self.books()["100:1"]
        self.assertEqual(b, {"key": "100:1", "title": "Single Book", "author": "Ann Author",
                             "series": "The Saga", "narrator": "Nora Reed",
                             "cover": "/library/metadata/100/thumb/1700000000",
                             "duration_ms": 1_000_000, "shape": "single"})
        self.assertEqual(self.books()["200:1"]["duration_ms"], 600_000)
        self.assertEqual(self.books()["300:1"]["narrator"], "Sam Lee")
        self.assertEqual(self.books()["300:1"]["title"], "Copied Book")
        self.assertEqual(self.books()["500:1"]["narrator"], "")

    def test_a_duplicate_copy_on_one_disc_is_not_played_twice(self):
        b = self.books()["300:1"]
        self.assertEqual(b["duration_ms"], 510_000)
        d = self.run_async(pp.book_detail("300:1"))
        self.assertEqual([t["key"] for t in d["tracks"]], ["302", "303"])

    def test_a_book_over_several_folders_stays_whole(self):
        d = self.run_async(pp.book_detail("600:1"))
        self.assertEqual([t["key"] for t in d["tracks"]], ["601", "602", "603", "604"])
        self.assertEqual(d["duration_ms"], 40_000)

    def test_a_multi_disc_album_titles_each_disc_from_its_tracks(self):
        books = self.books()
        self.assertEqual(books["400:1"]["title"], "First Tale")
        self.assertEqual(books["400:2"]["title"], "Second Tale")
        self.assertEqual(books["400:1"]["series"], "Long Series")
        self.assertEqual(books["400:1"]["narrator"], "Kim Moss")

    def test_plex_down_is_player_unavailable(self):
        self.plex.pms_down = 500
        with self.assertRaises(pp.PlayerUnavailable):
            self.run_async(pp.list_books())

    def test_player_off(self):
        self.admin["section"] = ""
        with self.assertRaises(pp.PlayerOff):
            self.run_async(pp.list_books())
        self.assertEqual(self.plex.calls, [])


# A series in three editions: Dan Voice's numbers every book one way or
# another, Fay Tone's none of hers (they take Dan's), and Fay has a fourth
# book Dan lacks. A fifth edition-less extra has no number at all.
SERIES_ALBUMS = {
    "1100": {"ratingKey": "1100", "type": "album", "title": "Cycle One - Read by Dan Voice",
             "parentTitle": "Jo Writer", "Collection": [{"tag": "The Cycle - Read by Dan Voice"}]},
    "1200": {"ratingKey": "1200", "type": "album", "title": "Cycle Two - Read by Dan Voice",
             "parentTitle": "Jo Writer", "Collection": [{"tag": "The Cycle - Read by Dan Voice"}]},
    "1300": {"ratingKey": "1300", "type": "album", "title": "Cycle Three - Read by Dan Voice",
             "titleSort": "The Cycle 3 - Cycle Three", "parentTitle": "Jo Writer",
             "Collection": [{"tag": "The Cycle - Read by Dan Voice"}]},
    "2100": {"ratingKey": "2100", "type": "album", "title": "Cycle \u2018One\u2019 - Read by Fay Tone",
             "parentTitle": "Jo Writer", "Collection": [{"tag": "The Cycle - Read by Fay Tone"}]},
    "2200": {"ratingKey": "2200", "type": "album", "title": "Cycle Two - Read by Fay Tone",
             "parentTitle": "Jo Writer", "Collection": [{"tag": "The Cycle - Read by Fay Tone"}]},
    "2400": {"ratingKey": "2400", "type": "album", "title": "Cycle Four - Read by Fay Tone",
             "parentTitle": "Jo Writer", "Collection": [{"tag": "The Cycle - Read by Fay Tone"}]},
    "3000": {"ratingKey": "3000", "type": "album", "title": "Cycle Extra - Read by Dan Voice",
             "parentTitle": "Jo Writer", "Collection": [{"tag": "The Cycle - Read by Dan Voice"}]},
    # A standalone book whose track says "Book 2": no series, so no next.
    "4000": {"ratingKey": "4000", "type": "album", "title": "Lone Book - Read by Dan Voice",
             "parentTitle": "Jo Writer"},
    # The same series name by another author is another series.
    "5100": {"ratingKey": "5100", "type": "album", "title": "Other Cycle - Read by Dan Voice",
             "parentTitle": "Sam Other", "Collection": [{"tag": "The Cycle - Read by Dan Voice"}]},
}


def series_track(rk, album, title, folder):
    return {"ratingKey": str(rk), "type": "track", "parentRatingKey": album, "parentIndex": 1, "index": 1,
            "duration": 60_000, "title": title,
            "Media": [{"Part": [{"key": f"/library/parts/{rk}/1/file.m4b",
                                 "file": f"/data/Audiobooks/Jo Writer/{folder}/{rk}.m4b"}]}]}


SERIES_TRACKS = {
    "1100": [series_track(1101, "1100", "Cycle One, Book 1", "Cycle One - Dan Voice")],
    "1200": [series_track(1201, "1200", "Cycle Two, Part 01", "Cycle Two, Book 2 - Dan Voice"),
             {**series_track(1202, "1200", "Cycle Two, Part 02", "Cycle Two, Book 2 - Dan Voice"), "index": 2}],
    "1300": [series_track(1301, "1300", "Cycle Three", "Cycle Three - Dan Voice")],
    "2100": [series_track(2101, "2100", "Cycle One", "Cycle One - Fay Tone")],
    "2200": [series_track(2201, "2200", "Cycle Two, Part 01", "Cycle Two - Fay Tone")],
    "2400": [series_track(2401, "2400", "Cycle Four (Vol. 4)", "Cycle Four - Fay Tone")],
    "3000": [series_track(3001, "3000", "Cycle Extra", "Cycle Extra - Dan Voice")],
    "4000": [series_track(4001, "4000", "Lone Book, Book 2", "Lone Book - Dan Voice")],
    "5100": [series_track(5101, "5100", "Other Cycle, Book 1", "Other Cycle - Dan Voice")],
}


class Series(BridgeBase):
    """The next book in a series (next_in_series): Plex has no series number
    for an album, so it is read from the text Plex has, and an edition
    without one takes it from another edition of the same title."""

    def setUp(self):
        super().setUp()
        for p in (mock.patch.dict(ALBUMS, SERIES_ALBUMS), mock.patch.dict(TRACKS, SERIES_TRACKS)):
            p.start()
            self.addCleanup(p.stop)

    def next(self, key):
        found = self.run_async(pp.next_in_series(key))
        return found and found["key"]

    def test_the_same_narrators_next_book(self):
        self.assertEqual(self.next("1100:1"), "1200:1")      # "Book 1" in the track title
        self.assertEqual(self.next("1200:1"), "1300:1")      # "Book 2" in the folder

    def test_an_edition_without_numbers_takes_them_from_another(self):
        self.assertEqual(self.next("2100:1"), "2200:1")      # curly quotes are the same title
        self.assertEqual(self.next("2200:1"), "1300:1")      # Fay has no third: Dan's

    def test_any_edition_when_the_narrators_lacks_the_next_number(self):
        self.assertEqual(self.next("1300:1"), "2400:1")      # 3 (the sort title), then Fay's 4 ("Vol. 4")

    def test_the_same_narrator_wins_even_when_another_sorts_first(self):
        # Fay's Cycle One: the second book exists as Dan's ("dan" sorts before
        # "fay") and as Fay's; Fay's is next.
        self.assertEqual(self.next("2100:1"), "2200:1")
        entries = [
            {"series": ("jo", "cycle"), "title": "one", "narrator": "zed reader", "number": 1, "book": {"key": "9:1"}},
            {"series": ("jo", "cycle"), "title": "two", "narrator": "amy voice", "number": 2, "book": {"key": "7:1"}},
            {"series": ("jo", "cycle"), "title": "two", "narrator": "zed reader", "number": 2, "book": {"key": "8:1"}},
        ]
        self.assertEqual(pp.pick_next(entries, "9:1")["key"], "8:1")
        entries[0]["narrator"] = ""          # a narrator we don't know: any edition, in order
        self.assertEqual(pp.pick_next(entries, "9:1")["key"], "7:1")

    def test_the_last_book_an_unnumbered_one_and_a_standalone_have_none(self):
        self.assertIsNone(self.next("2400:1"))
        self.assertIsNone(self.next("3000:1"))
        self.assertIsNone(self.next("4000:1"))
        self.assertIsNone(self.next("200:1"))                 # no collection at all

    def test_another_authors_series_of_the_same_name_is_apart(self):
        self.assertIsNone(self.next("5100:1"))

    def test_a_multi_disc_albums_discs_are_its_series(self):
        self.assertEqual(self.next("400:1"), "400:2")
        self.assertIsNone(self.next("400:2"))

    def test_the_book_fields_are_list_books_fields(self):
        found = self.run_async(pp.next_in_series("1100:1"))
        self.assertEqual(found, {"key": "1200:1", "title": "Cycle Two", "author": "Jo Writer",
                                 "series": "The Cycle", "narrator": "Dan Voice", "cover": "",
                                 "duration_ms": 120_000, "shape": "parts"})

    def test_a_malformed_key_makes_no_plex_call(self):
        for key in ("1100", "x:1", "1100:1:1", ""):
            with self.subTest(key=key):
                with self.assertRaises(pp.NotInLibrary):
                    self.run_async(pp.next_in_series(key))
        self.assertEqual(self.plex.calls, [])

    def test_a_key_not_in_the_library_has_none(self):
        self.assertIsNone(self.next("9999:1"))

    def test_plex_down_is_player_unavailable_and_off_is_player_off(self):
        self.plex.pms_down = 500
        with self.assertRaises(pp.PlayerUnavailable):
            self.run_async(pp.next_in_series("1100:1"))
        self.plex.pms_down = None
        self.admin["section"] = ""
        with self.assertRaises(pp.PlayerOff):
            self.run_async(pp.next_in_series("1100:1"))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SeriesNumbers(unittest.TestCase):
    def test_where_a_number_is_read(self):
        cases = [
            (("Harry Porter and the Cup, Book 4, Part 01",), "Harry Porter", 4),
            (("Title, Part 01",), "Title", None),
            (("The Cycle 6 - Title",), "The Cycle", 6),
            (("Mules II: The Road",), "Mules", 2),
            (("Mules XIV",), "Mules", 14),
            (("Mules Civil",), "Mules", None),
            (("Mules IIII",), "Mules", None),
            (("Harry Porter and the Cup",), "Harry Porter", None),
            (("Vol. 3",), "", 3),
            (("#12 The Case",), "", 12),
            (("Books 1-3",), "", None),
            (("Notebook 3",), "", None),
            ((None, "", "Title (Book 7)"), "Other", 7),
            (("Title, Book 1234",), "", None),
        ]
        for texts, series, want in cases:
            with self.subTest(texts=texts):
                self.assertEqual(pp._series_number(texts, series), want)

    def test_editions_match_by_title_without_number_case_or_quotes(self):
        self.assertEqual(pp._title_key("The Sorcerer\u2019s Stone"), pp._title_key("the sorcerer's stone"))
        self.assertEqual(pp._title_key("Cup, Book 4"), pp._title_key("Cup"))
        self.assertNotEqual(pp._title_key("Philosopher's Stone"), pp._title_key("Sorcerer's Stone"))


def disc_track(rk, index, duration, folder):
    return {"ratingKey": str(rk), "type": "track", "parentIndex": 1, "index": index, "duration": duration,
            "Media": [{"Part": [{"key": f"/library/parts/{rk}/1/file.mp3",
                                 "file": f"/data/Audiobooks/{folder}/{rk}.mp3"}]}]}


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Copies(unittest.TestCase):
    def keys(self, tracks):
        return [t["ratingKey"] for t in pp._discs(tracks)[1]]

    def test_a_multi_cd_rip_that_restarts_numbering_keeps_every_cd_in_order(self):
        tracks = [disc_track(9, 1, 50_000, "Rip/CD10"),
                  disc_track(3, 1, 80_000, "Rip/CD2"), disc_track(4, 2, 90_000, "Rip/CD2"),
                  disc_track(2, 2, 70_000, "Rip/CD1"), disc_track(1, 1, 60_000, "Rip/CD1")]
        self.assertEqual(self.keys(tracks), ["1", "2", "3", "4", "9"])

    def test_cds_of_matching_length_but_different_tracks_are_not_copies(self):
        tracks = [disc_track(1, 1, 100_000, "Rip/CD1"), disc_track(2, 2, 200_000, "Rip/CD1"),
                  disc_track(3, 1, 200_000, "Rip/CD2"), disc_track(4, 2, 100_000, "Rip/CD2")]
        self.assertEqual(self.keys(tracks), ["1", "2", "3", "4"])

    def test_two_copies_of_the_same_parts_keep_one(self):
        tracks = [disc_track(1, 1, 100_000, "B/Copy A"), disc_track(2, 2, 200_000, "B/Copy A"),
                  disc_track(3, 1, 101_000, "B/Copy B"), disc_track(4, 2, 199_500, "B/Copy B")]
        # The longer copy wins.
        self.assertEqual(self.keys(tracks), ["3", "4"])

    def test_a_whole_file_and_its_parts_keep_one(self):
        tracks = [disc_track(1, 1, 300_500, "B/Whole"),
                  disc_track(2, 1, 100_000, "B/Parts"), disc_track(3, 2, 200_000, "B/Parts")]
        self.assertEqual(self.keys(tracks), ["1"])

    def test_a_near_copy_with_a_different_track_count_is_kept_whole(self):
        tracks = [disc_track(1, 1, 100_000, "B/Three"), disc_track(2, 2, 100_000, "B/Three"),
                  disc_track(3, 3, 100_000, "B/Three"),
                  disc_track(4, 1, 150_000, "B/Two"), disc_track(5, 2, 150_000, "B/Two")]
        self.assertEqual(self.keys(tracks), ["1", "2", "3", "4", "5"])

    def test_a_long_copy_with_one_part_cut_differently_still_dedupes(self):
        # Ten parts; part 7 is 8% longer in the second rip, the rest agree
        # and the totals stay within 1%.
        a = [disc_track(i, i, 1_000_000, "B/Rip A") for i in range(1, 11)]
        b = [disc_track(100 + i, i, 1_080_000 if i == 7 else 1_000_500, "B/Rip B") for i in range(1, 11)]
        self.assertEqual(len(self.keys(a + b)), 10)

    def test_two_mismatched_parts_in_ten_are_not_copies(self):
        a = [disc_track(i, i, 1_000_000, "B/Rip A") for i in range(1, 11)]
        b = [disc_track(100 + i, i, 1_100_000 if i in (3, 7) else 1_000_000, "B/Rip B") for i in range(1, 11)]
        self.assertEqual(len(self.keys(a + b)), 20)

    def test_fixed_length_cd_folders_that_match_exactly_are_both_kept(self):
        # A rip cut into fixed-length tracks: CD1 and CD2 match track for
        # track and in total, but their names say they are two discs.
        cd = [disc_track(10 + i, i, 600_000, "Rip/Book Title - CD1") for i in (1, 2, 3)]
        cd += [disc_track(20 + i, i, 600_000, "Rip/Book Title - CD2") for i in (1, 2, 3)]
        self.assertEqual(self.keys(list(reversed(cd))), ["11", "12", "13", "21", "22", "23"])

    def test_the_same_folders_under_names_that_are_not_a_sequence_still_dedupe(self):
        cd = [disc_track(10 + i, i, 600_000, "Rip/Book Title") for i in (1, 2, 3)]
        cd += [disc_track(20 + i, i, 600_000, "Rip/Book Title (1)") for i in (1, 2, 3)]
        self.assertEqual(len(self.keys(cd)), 3)

    def test_a_cd_set_is_never_absorbed_through_a_third_folder(self):
        # CD1 totals 4,000,000 ms and "Extra" is one file of 4,000,050 ms:
        # CD1 must not be dropped as a copy of Extra (or Extra of CD1).
        tracks = [disc_track(1, 1, 2_000_000, "Rip/CD1"), disc_track(2, 2, 2_000_000, "Rip/CD1"),
                  disc_track(3, 1, 1_900_000, "Rip/CD2"), disc_track(4, 2, 1_800_000, "Rip/CD2"),
                  disc_track(999, 1, 4_000_050, "Rip/Extra")]
        self.assertEqual(self.keys(tracks), ["1", "2", "3", "4", "999"])

    def test_a_mixed_keyword_cd_set_plays_by_disc_number(self):
        tracks = [disc_track(5, 1, 60_000, "Rip/CD3"), disc_track(6, 2, 61_000, "Rip/CD3"),
                  disc_track(3, 1, 62_000, "Rip/Disc2"), disc_track(4, 2, 63_000, "Rip/Disc2"),
                  disc_track(1, 1, 64_000, "Rip/CD1"), disc_track(2, 2, 65_000, "Rip/CD1")]
        self.assertEqual(self.keys(tracks), ["1", "2", "3", "4", "5", "6"])

    def test_copies_beside_a_cd_set_still_dedupe_among_themselves(self):
        tracks = [disc_track(1, 1, 100_000, "Rip/CD1"), disc_track(2, 1, 100_000, "Rip/CD2"),
                  disc_track(3, 1, 500_000, "Rip/Whole"), disc_track(4, 1, 500_500, "Rip/Whole (1)")]
        self.assertEqual(self.keys(tracks), ["1", "2", "4"])

    def test_disc_sibling_names(self):
        for a, b in (("CD1", "CD2"), ("Disc 1", "Disc 2"), ("CD 01", "CD 02"), ("Part 1", "Part 2"),
                     ("Book Title - CD3", "Book Title - CD4"), ("book title - cd9", "Book Title - CD10"),
                     ("Title/Disk_1", "Title/Disk_2"), ("x/CD2", "y/CD3")):
            with self.subTest(a=a, b=b):
                self.assertTrue(pp._disc_siblings(a, b))
        for a, b in (("Book Title", "Book Title (1)"), ("CD 01", "CD1"), ("CD1", "CD1"),
                     ("Title, Book 7", "Title, Book 8"), ("Alpha CD1", "Beta CD2"), ("Title 1", "Title 2"),
                     ("Harry Potter and the Deathly Hallows - Jim Dale",
                      "Harry Potter and the Deathly Hallows, Book 7 - Jim Dale")):
            with self.subTest(a=a, b=b):
                self.assertFalse(pp._disc_siblings(a, b))

    def test_durations_outside_tolerance_are_not_copies(self):
        # 2.5 s apart on a 100 s part: over max(2 s, 1%).
        tracks = [disc_track(1, 1, 100_000, "B/A"), disc_track(2, 1, 102_500, "B/B")]
        self.assertEqual(self.keys(tracks), ["1", "2"])


class Detail(BridgeBase):
    def test_single_file_book_chapters(self):
        d = self.run_async(pp.book_detail("100:1"))
        self.assertEqual(d["title"], "Single Book")
        self.assertEqual(d["author"], "Ann Author")
        self.assertEqual(d["cover"], "/library/metadata/100/thumb/1700000000")
        self.assertEqual(d["shape"], "single")
        self.assertEqual(d["tracks"], [{"key": "101", "part_path": "/library/parts/1019/1700000000/file.m4b",
                                        "duration_ms": 1_000_000, "index": 1, "container": "mp4",
                                        "codec": "eac3", "profile": "dolby digital plus + dolby atmos"}])
        self.assertEqual(d["chapters"], [
            {"index": 1, "label": "Chapter 1 of 3", "start_ms": 0, "end_ms": 300_000, "track": "101",
             "track_start_ms": 0, "track_end_ms": 300_000},
            {"index": 2, "label": "Chapter 2 of 3", "start_ms": 300_000, "end_ms": 700_000, "track": "101",
             "track_start_ms": 300_000, "track_end_ms": 700_000},
            # The last chapter runs to the end of the file.
            {"index": 3, "label": "Chapter 3 of 3", "start_ms": 700_000, "end_ms": 1_000_000, "track": "101",
             "track_start_ms": 700_000, "track_end_ms": 1_000_000},
        ])
        chap = [c for c in self.plex.calls if c.url.path == "/library/metadata/101"][0]
        self.assertIn(b"includeChapters=1", chap.url.query)

    def test_each_track_carries_its_container_codec_and_profile(self):
        parts = self.run_async(pp.book_detail("200:1"))["tracks"]
        self.assertEqual([(t["container"], t["codec"], t["profile"]) for t in parts], [("mp3", "mp3", "")] * 3)
        # Each track its own: the first part is AAC, the second says nothing.
        halves = self.run_async(pp.book_detail("700:1"))["tracks"]
        self.assertEqual([(t["key"], t["container"], t["codec"], t["profile"]) for t in halves],
                         [("701", "mp4", "aac", "lc"), ("702", "", "", "")])
        # Plex saying nothing is three empty strings (the player then plays it direct).
        quiet = self.run_async(pp.book_detail("500:1"))["tracks"][0]
        self.assertEqual((quiet["container"], quiet["codec"], quiet["profile"]), ("", "", ""))

    def test_the_first_media_and_part_are_the_tracks(self):
        two = dict(TRACKS["500"][0], Media=[
            {"container": "mp4", "audioCodec": "aac", "audioProfile": "lc",
             "Part": [{"key": "/library/parts/5019/1/first.m4b"}, {"key": "/library/parts/5019/2/second.m4b"}]},
            {"container": "mp4", "audioCodec": "eac3", "Part": [{"key": "/library/parts/5019/3/other.m4b"}]},
        ])
        with mock.patch.dict(TRACKS, {"500": [two]}):
            t = self.run_async(pp.book_detail("500:1"))["tracks"][0]
        self.assertEqual((t["part_path"], t["container"], t["codec"], t["profile"]),
                         ("/library/parts/5019/1/first.m4b", "mp4", "aac", "lc"))

    def test_titled_chapters_keep_their_title(self):
        d = self.run_async(pp.book_detail("400:2"))
        self.assertEqual([c["label"] for c in d["chapters"]], ["Opening Credits", "Chapter 2 of 2"])
        self.assertEqual(d["chapters"][-1]["end_ms"], 70_000)

    def test_single_file_without_chapters_is_one_chapter(self):
        d = self.run_async(pp.book_detail("500:1"))
        self.assertEqual(d["chapters"], [{"index": 1, "label": "Chapter 1 of 1", "start_ms": 0,
                                          "end_ms": 90_000, "track": "501",
                                          "track_start_ms": 0, "track_end_ms": 90_000}])

    def test_mp3_parts_without_chapters_stay_parts(self):
        d = self.run_async(pp.book_detail("200:1"))
        self.assertEqual(d["shape"], "parts")
        self.assertEqual([t["key"] for t in d["tracks"]], ["201", "202", "203"])
        self.assertEqual([t["index"] for t in d["tracks"]], [1, 2, 3])
        self.assertEqual(d["chapters"], [
            {"index": 1, "label": "Part 1 of 3", "start_ms": 0, "end_ms": 100_000, "track": "201",
             "track_start_ms": 0, "track_end_ms": 100_000},
            {"index": 2, "label": "Part 2 of 3", "start_ms": 100_000, "end_ms": 300_000, "track": "202",
             "track_start_ms": 0, "track_end_ms": 200_000},
            {"index": 3, "label": "Part 3 of 3", "start_ms": 300_000, "end_ms": 600_000, "track": "203",
             "track_start_ms": 0, "track_end_ms": 300_000},
        ])
        # The parts were asked for their chapters, in one request.
        chap = [c for c in self.plex.calls if b"includeChapters=1" in c.url.query]
        self.assertEqual([c.url.path for c in chap], ["/library/metadata/201,202,203"])

    def test_parts_with_chapters_in_every_part_use_them_across_the_book(self):
        d = self.run_async(pp.book_detail("700:1"))
        self.assertEqual(d["shape"], "parts")
        self.assertEqual(d["chapters"], [
            {"index": 1, "label": "Chapter 01 - The Start", "start_ms": 0, "end_ms": 60_000,
             "track": "701", "track_start_ms": 0, "track_end_ms": 60_000},
            # A part's last chapter ends at the part's end, not Plex's figure.
            {"index": 2, "label": "Chapter 02 - The Road", "start_ms": 60_000, "end_ms": 100_000,
             "track": "701", "track_start_ms": 60_000, "track_end_ms": 100_000},
            {"index": 3, "label": "Chapter 03 - The Inn", "start_ms": 100_000, "end_ms": 130_000,
             "track": "702", "track_start_ms": 0, "track_end_ms": 30_000},
            # Untitled: numbered across the whole book.
            {"index": 4, "label": "Chapter 4 of 5", "start_ms": 130_000, "end_ms": 150_000,
             "track": "702", "track_start_ms": 30_000, "track_end_ms": 50_000},
            {"index": 5, "label": "Chapter 05 - Home", "start_ms": 150_000, "end_ms": 180_000,
             "track": "702", "track_start_ms": 50_000, "track_end_ms": 80_000},
        ])
        self.assertEqual(d["chapters"][-1]["end_ms"], d["duration_ms"])

    def test_mixed_parts_count_a_part_without_chapters_as_one_chapter(self):
        d = self.run_async(pp.book_detail("800:1"))
        self.assertEqual(d["chapters"], [
            {"index": 1, "label": "Prologue", "start_ms": 0, "end_ms": 20_000,
             "track": "801", "track_start_ms": 0, "track_end_ms": 20_000},
            {"index": 2, "label": "Chapter 2 of 3", "start_ms": 20_000, "end_ms": 50_000,
             "track": "801", "track_start_ms": 20_000, "track_end_ms": 50_000},
            {"index": 3, "label": "Chapter 3 of 3", "start_ms": 50_000, "end_ms": 90_000,
             "track": "802", "track_start_ms": 0, "track_end_ms": 40_000},
        ])

    def test_chapter_requests_are_batched(self):
        with mock.patch.object(pp, "CHAPTER_BATCH", 2):
            d = self.run_async(pp.book_detail("200:1"))
        chap = [c.url.path for c in self.plex.calls if b"includeChapters=1" in c.url.query]
        self.assertEqual(chap, ["/library/metadata/201,202", "/library/metadata/203"])
        self.assertEqual(len(d["chapters"]), 3)

    def test_unknown_or_foreign_book_is_not_in_library(self):
        for key in ("999:1", "900:1", "200:7"):
            with self.subTest(key=key):
                with self.assertRaises(pp.NotInLibrary):
                    self.run_async(pp.book_detail(key))


class Membership(BridgeBase):
    def test_accepts_a_book_in_the_section(self):
        self.run_async(pp.assert_in_library("200:1"))
        self.run_async(pp.assert_in_library("200:1", track_key="202"))

    def test_rejects_an_album_from_another_section(self):
        with self.assertRaises(pp.NotInLibrary):
            self.run_async(pp.assert_in_library("900:1"))

    def test_rejects_a_missing_album(self):
        with self.assertRaises(pp.NotInLibrary):
            self.run_async(pp.assert_in_library("999:1"))

    def test_rejects_a_track_from_another_book(self):
        for key, track_key in (("200:1", "101"), ("200:1", "901"), ("200:1", "411"), ("200:1", "999"),
                               ("400:2", "401"), ("400:1", "411")):
            with self.subTest(key=key, track=track_key):
                with self.assertRaises(pp.NotInLibrary):
                    self.run_async(pp.assert_in_library(key, track_key=track_key))
        self.run_async(pp.assert_in_library("400:2", track_key="411"))

    def test_malformed_keys_are_rejected_before_any_plex_call(self):
        for key in ("", "200", "200:", ":1", "200:1:3", "abc:1", "200:x", "../200:1", "200:1 ",
                    "-1:1", "1e3:1", "２００:1", "1" * 30 + ":1", None, 200):
            with self.subTest(key=key):
                with self.assertRaises(pp.NotInLibrary):
                    self.run_async(pp.assert_in_library(key))
        for track_key in ("", "abc", "20 2", "../202"):
            with self.subTest(track=track_key):
                with self.assertRaises(pp.NotInLibrary):
                    self.run_async(pp.assert_in_library("200:1", track_key=track_key))
        self.assertEqual(self.plex.calls, [])

    def test_player_off_is_not_in_library(self):
        self.admin["section"] = ""
        with self.assertRaises(pp.NotInLibrary):
            self.run_async(pp.assert_in_library("200:1"))
        self.assertEqual(self.plex.calls, [])

    def test_plex_down_is_player_unavailable(self):
        self.plex.pms_down = 503
        with self.assertRaises(pp.PlayerUnavailable):
            self.run_async(pp.assert_in_library("200:1"))


class Position(BridgeBase):
    T1 = 1_790_000_000   # epoch seconds
    T2 = 1_790_000_600

    def stamp(self, secs):
        return datetime.fromtimestamp(secs, timezone.utc).replace(tzinfo=None).isoformat(
            timespec="milliseconds") + "Z"

    def test_picks_the_in_progress_track_and_sums_finished_parts(self):
        self.plex.state[SERVER_TOKEN] = {
            "201": {"viewCount": 1, "lastViewedAt": self.T1},
            "202": {"viewOffset": 45_000, "lastViewedAt": self.T2},
        }
        pos = self.run_async(pp.plex_position(listener(), "200:1", session_id=SID))
        self.assertEqual(pos["track"], "202")
        self.assertEqual(pos["offset_ms"], 45_000)
        self.assertEqual(pos["duration_ms"], 200_000)
        self.assertEqual(pos["book_ms"], 100_000 + 45_000)
        self.assertEqual(pos["book_duration_ms"], 600_000)
        self.assertEqual(pos["updated_at"], self.stamp(self.T2))
        self.assertRegex(pos["updated_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
        self.assertEqual(pos["source"], "plex")
        # The per-track state was read with the listener's server token.
        reads = [c for c in self.plex.calls if c.url.path == "/library/metadata/200/children"]
        self.assertIn(SERVER_TOKEN, [c.headers["X-Plex-Token"] for c in reads])
        self.assert_no_token_in_urls()

    def test_only_a_later_track_has_state(self):
        # book_ms is the playhead in book time: every earlier part counts,
        # whatever Plex says about it, and resume lands on track 3 at 50 s.
        self.plex.state[SERVER_TOKEN] = {"203": {"viewOffset": 50_000, "lastViewedAt": self.T1}}
        pos = self.run_async(pp.plex_position(listener(), "200:1", session_id=SID))
        self.assertEqual((pos["track"], pos["offset_ms"], pos["book_ms"]), ("203", 50_000, 350_000))

    def test_a_finished_part_newer_than_an_old_offset_moves_to_the_next_part(self):
        self.plex.state[SERVER_TOKEN] = {
            "201": {"viewOffset": 10_000, "lastViewedAt": self.T1},
            "202": {"viewCount": 1, "lastViewedAt": self.T2},
        }
        pos = self.run_async(pp.plex_position(listener(), "200:1", session_id=SID))
        self.assertEqual((pos["track"], pos["offset_ms"], pos["book_ms"]), ("203", 0, 300_000))

    def test_a_finished_book_sits_at_its_end(self):
        self.plex.state[SERVER_TOKEN] = {"203": {"viewCount": 2, "lastViewedAt": self.T2}}
        pos = self.run_async(pp.plex_position(listener(), "200:1", session_id=SID))
        self.assertEqual((pos["track"], pos["offset_ms"], pos["book_ms"]), ("203", 300_000, 600_000))

    def test_single_file_offset(self):
        self.plex.state[SERVER_TOKEN] = {"101": {"viewOffset": 654_321, "lastViewedAt": self.T1}}
        pos = self.run_async(pp.plex_position(listener(), "100:1", session_id=SID))
        self.assertEqual((pos["track"], pos["offset_ms"], pos["book_ms"]), ("101", 654_321, 654_321))

    def test_nothing_played_is_none(self):
        self.assertIsNone(self.run_async(pp.plex_position(listener(), "200:1", session_id=SID)))

    def test_another_listeners_state_is_not_read(self):
        self.plex.state[ADMIN_TOKEN] = {"202": {"viewOffset": 45_000, "lastViewedAt": self.T2}}
        self.assertIsNone(self.run_async(pp.plex_position(listener(), "200:1", session_id=SID)))

    def test_bad_key_is_not_in_library(self):
        with self.assertRaises(pp.NotInLibrary):
            self.run_async(pp.plex_position(listener(), "nope", session_id=SID))
        self.assertEqual(self.plex.calls, [])


class Timeline(BridgeBase):
    def timeline_calls(self):
        return [c for c in self.plex.calls if c.url.path == "/:/timeline"]

    def test_sends_the_documented_params_with_the_listeners_server_token(self):
        self.run_async(pp.timeline(listener(), "202", "playing", 45_000, 200_000, session_id=SID))
        calls = self.timeline_calls()
        self.assertEqual(len(calls), 1)
        c = calls[0]
        self.assertEqual(c.method, "GET")
        self.assertEqual(f"{c.url.scheme}://{c.url.host}:{c.url.port}", ADMIN_URL)
        q = {k: v[0] for k, v in parse_qs(c.url.query.decode()).items()}
        self.assertEqual(q, {"ratingKey": "202", "key": "/library/metadata/202", "state": "playing",
                             "time": "45000", "duration": "200000",
                             "identifier": "com.plexapp.plugins.library"})
        self.assertEqual(c.headers["X-Plex-Token"], SERVER_TOKEN)
        self.assertEqual(c.headers["X-Plex-Product"], "WebServarr")
        self.assertTrue(c.headers["X-Plex-Client-Identifier"].startswith("webservarr-player-"))
        self.assert_no_token_in_urls()

    def test_client_identifier_is_stable_and_per_listener(self):
        a = pp.client_identifier(listener())
        self.assertEqual(a, pp.client_identifier(listener()))
        self.assertNotEqual(a, pp.client_identifier(listener(plex_account_id="2002")))
        self.assertNotIn("1001", a)

    def test_time_is_clamped_and_state_checked(self):
        self.run_async(pp.timeline(listener(), "202", "paused", 999_999, 200_000, session_id=SID))
        q = parse_qs(self.timeline_calls()[0].url.query.decode())
        self.assertEqual(q["time"], ["200000"])
        n = len(self.timeline_calls())
        self.run_async(pp.timeline(listener(), "202", "rewinding", 1, 2, session_id=SID))
        self.run_async(pp.timeline(listener(), "../202", "playing", 1, 2, session_id=SID))
        self.assertEqual(len(self.timeline_calls()), n)

    def test_errors_are_swallowed(self):
        self.plex.timeline_down = True
        self.assertIsNone(self.run_async(pp.timeline(listener(), "202", "playing", 1, 2, session_id=SID)))
        self.assertIsNone(self.run_async(pp.timeline(listener(plex_token=""), "202", "playing", 1, 2)))
        self.plex.plextv_down = "connect"
        self.assertIsNone(self.run_async(pp.timeline(listener(), "202", "stopped", 1, 2)))


class LibraryAccess(BridgeBase):
    """The listener's own server token must read the audiobook section: a
    share can leave it out, and the book list is read with the admin token."""

    def test_a_listener_whose_share_includes_the_section_gets_access(self):
        out = self.run_async(pp.library_access(listener(), session_id=SID))
        self.assertEqual(out["token"], SERVER_TOKEN)
        check = [c for c in self.plex.calls if c.url.path == "/library/sections"]
        self.assertEqual(len(check), 1)
        self.assertEqual(check[0].headers["X-Plex-Token"], SERVER_TOKEN)
        self.assert_no_token_in_urls()

    def test_a_share_without_the_section_is_no_library_access(self):
        self.plex.sections = {SERVER_TOKEN: ["5", "6"]}
        with self.assertRaises(pp.NoLibraryAccess) as ctx:
            self.run_async(pp.library_access(listener(), session_id=SID))
        self.assertIsInstance(ctx.exception, pp.NoServerAccess)
        self.assertNotIn("section", self.cached_blob())

    def test_the_check_is_remembered_with_the_cached_access(self):
        session = listener()
        self.run_async(pp.library_access(session, session_id=SID))
        blob = self.cached_blob()
        self.assertEqual(blob["section"], SECTION)
        self.assertEqual(blob["token"], SERVER_TOKEN)
        # The next request carries it from Redis: no Plex call at all.
        n = len(self.plex.calls)
        again = self.run_async(pp.library_access(listener(**{pp.SERVER_FIELD: json.dumps(blob)}), session_id=SID))
        self.assertEqual(again["token"], SERVER_TOKEN)
        self.assertEqual(len(self.plex.calls), n)

    def test_a_refusal_is_not_remembered(self):
        self.plex.sections = {SERVER_TOKEN: ["5"]}
        session = listener()
        with self.assertRaises(pp.NoLibraryAccess):
            self.run_async(pp.library_access(session, session_id=SID))
        self.plex.sections = {}
        self.assertEqual(self.run_async(pp.library_access(session, session_id=SID))["token"], SERVER_TOKEN)

    def test_a_different_library_setting_checks_again(self):
        self.run_async(pp.library_access(listener(), session_id=SID))
        blob = self.cached_blob()
        self.admin["section"] = "5"
        n = len(self.plex.calls)
        self.run_async(pp.library_access(listener(**{pp.SERVER_FIELD: json.dumps(blob)}), session_id=SID))
        self.assertIn("/library/sections", [c.url.path for c in self.plex.calls[n:]])
        self.assertEqual(self.cached_blob()["section"], "5")

    def test_force_refetches_and_checks_again(self):
        self.run_async(pp.library_access(listener(), session_id=SID))
        cached = listener(**{pp.SERVER_FIELD: json.dumps(self.cached_blob())})
        n = len(self.plex.calls)
        self.run_async(pp.library_access(cached, session_id=SID, force=True))
        paths = [c.url.path for c in self.plex.calls[n:]]
        self.assertIn("/api/v2/resources", paths)
        self.assertIn("/library/sections", paths)

    def test_a_401_on_the_listeners_token_drops_the_cache(self):
        self.run_async(pp.server_access(listener(), session_id=SID))
        session = listener(**{pp.SERVER_FIELD: json.dumps(self.cached_blob())})
        self.update_session.reset_mock()
        self.plex.reject_tokens = {SERVER_TOKEN}
        with self.assertRaises(pp.TokenRejected):
            self.run_async(pp.library_access(session, session_id=SID))
        self.update_session.assert_awaited_once_with(SID, {pp.SERVER_FIELD: ""})

    def test_no_plex_token_is_no_server_access(self):
        with self.assertRaises(pp.NoServerAccess):
            self.run_async(pp.library_access(listener(plex_token=""), session_id=SID))

    def test_player_off(self):
        self.admin["section"] = ""
        self.assertFalse(pp.player_on())
        with self.assertRaises(pp.PlayerOff):
            self.run_async(pp.library_access(listener(), session_id=SID))
        self.admin["section"] = SECTION
        self.assertTrue(pp.player_on())


class Cover(BridgeBase):
    def setUp(self):
        super().setUp()
        p = mock.patch.object(pp.plex, "_get_config", lambda: {"url": ADMIN_URL, "token": ADMIN_TOKEN})
        p.start()
        self.addCleanup(p.stop)

    def test_a_cover_fitted_to_a_square_through_the_photo_transcoder(self):
        content, ctype = self.run_async(pp.cover_image("100:1"))
        self.assertEqual((content, ctype), (b"\x89PNG-or-JPEG", "image/jpeg"))
        call = [c for c in self.plex.calls if c.url.path == "/photo/:/transcode"][0]
        q = parse_qs(call.url.query.decode())
        self.assertEqual(q["width"], [str(pp.COVER_SIZE)])
        self.assertEqual(q["height"], [str(pp.COVER_SIZE)])
        self.assertEqual(q["url"], ["/library/metadata/100/thumb/1700000000"])
        # Fitted inside the square, never covering it: Plex cannot crop, and
        # a tall print cover must not come back 600 wide and 930 high.
        self.assertNotIn("minSize", q)
        self.assertEqual(call.headers["X-Plex-Token"], ADMIN_TOKEN)
        self.assert_no_token_in_urls()

    def test_a_key_outside_the_library_never_reaches_the_transcoder(self):
        for key in ("900:1", "999:1", "junk", "100"):
            with self.subTest(key=key), self.assertRaises(pp.NotInLibrary):
                self.run_async(pp.cover_image(key))
        self.assertNotIn("/photo/:/transcode", self.plex.paths())

    def test_a_malformed_key_makes_no_plex_call(self):
        with self.assertRaises(pp.NotInLibrary):
            self.run_async(pp.cover_image("../1"))
        self.assertEqual(self.plex.calls, [])

    def test_no_cover_or_an_unsafe_image_is_not_found(self):
        with mock.patch.dict(ALBUMS["500"], {"thumb": ""}):
            with self.assertRaises(pp.NotInLibrary):
                self.run_async(pp.cover_image("500:1"))
        with mock.patch.dict(ALBUMS["500"], {"thumb": "/library/sections/all/refresh?force=1"}):
            with self.assertRaises(pp.NotInLibrary):
                self.run_async(pp.cover_image("500:1"))
        self.plex.photo_type = "image/svg+xml"
        with self.assertRaises(pp.NotInLibrary):
            self.run_async(pp.cover_image("100:1"))

    def test_player_off_and_plex_down(self):
        self.plex.pms_down = 500
        with self.assertRaises(pp.PlayerUnavailable):
            self.run_async(pp.cover_image("100:1"))
        self.admin["section"] = ""
        with self.assertRaises(pp.PlayerOff):
            self.run_async(pp.cover_image("100:1"))

    def test_cover_version(self):
        self.assertEqual(pp.cover_version("/library/metadata/100/thumb/1700000000"), "1700000000")
        for bad in ("", None, "/library/metadata/100/art/1", "/library/metadata/100/thumb/1?x=1",
                    "https://x/library/metadata/100/thumb/1"):
            self.assertEqual(pp.cover_version(bad), "", bad)


class Shapes(BridgeBase):
    """Plex answering in an unexpected shape is an outage (503), never a
    crash (500); the listener's own odd state only means no Plex place."""

    def test_any_plex_read_of_an_unexpected_shape_is_player_unavailable(self):
        for body in ([], ["x"], {"MediaContainer": []}, {"MediaContainer": ["x"]}, {"MediaContainer": 5}):
            with self.subTest(body=body):
                self.plex.raw["/library/metadata/100"] = body
                with self.assertRaises(pp.PlayerUnavailable):
                    self.run_async(pp.book_detail("100:1"))
                with self.assertRaises(pp.PlayerUnavailable):
                    self.run_async(pp.assert_in_library("100:1"))
        # An empty answer is still an empty container (not in the library).
        for body in ({}, {"MediaContainer": None}, {"MediaContainer": {}}):
            with self.subTest(body=body):
                self.plex.raw["/library/metadata/100"] = body
                with self.assertRaises(pp.NotInLibrary):
                    self.run_async(pp.assert_in_library("100:1"))

    def test_metadata_that_is_not_a_list_of_objects_is_player_unavailable(self):
        all_path = f"/library/sections/{SECTION}/all"
        for meta in ({"k": 1}, [None], ["x"], "abc", 5):
            body = {"MediaContainer": {"Metadata": meta, "librarySectionID": int(SECTION)}}
            reads = (
                ("list_books", lambda: pp.list_books(), all_path),
                ("book_detail album", lambda: pp.book_detail("100:1"), "/library/metadata/100"),
                ("book_detail children", lambda: pp.book_detail("100:1"), "/library/metadata/100/children"),
                ("assert_in_library track", lambda: pp.assert_in_library("100:1", "101"), "/library/metadata/101"),
            )
            for name, run, path in reads:
                with self.subTest(read=name, metadata=meta):
                    self.plex.raw = {path: body}
                    with self.assertRaises(pp.PlayerUnavailable):
                        self.run_async(run())
        # Sections that are not a list of objects: the library check cannot be made.
        self.plex.raw = {"/library/sections": {"MediaContainer": {"Directory": {"key": SECTION}}}}
        with self.assertRaises(pp.PlayerUnavailable):
            self.run_async(pp.library_access(listener(), session_id=SID))

    def test_plex_position_with_listener_state_of_an_odd_shape_is_none(self):
        for meta in ({"k": 1}, [None], ["x"], "abc"):
            with self.subTest(metadata=meta):
                self.plex.raw = {}
                # The admin view of the book is fine; the listener's own read is odd.
                orig = self.plex.handle

                def handle(request, orig=orig, meta=meta):
                    if request.url.path == "/library/metadata/200/children" and \
                            request.headers.get("X-Plex-Token") == SERVER_TOKEN:
                        self.plex.calls.append(request)
                        return httpx.Response(200, json={"MediaContainer": {"Metadata": meta}})
                    return orig(request)
                self.plex.handle = handle
                try:
                    self.assertIsNone(self.run_async(pp.plex_position(listener(), "200:1", session_id=SID)))
                finally:
                    self.plex.handle = orig

    def test_a_track_whose_media_is_odd_still_reads(self):
        odd = dict(TRACKS["500"][0], Media={"Part": []})
        with mock.patch.dict(TRACKS, {"500": [odd]}):
            d = self.run_async(pp.book_detail("500:1"))
        self.assertEqual((d["tracks"][0]["part_path"], d["tracks"][0]["codec"]), ("", ""))


class NoTokenLogged(BridgeBase):
    def test_no_token_reaches_a_log_line_or_an_error(self):
        root = logging.getLogger()
        old_level = root.level
        root.setLevel(logging.DEBUG)
        self.addCleanup(root.setLevel, old_level)
        errors = []

        def attempt(coro):
            try:
                self.run_async(coro)
            except Exception as exc:  # noqa: BLE001 - collected and checked below
                errors.append(repr(exc) + str(exc) + repr(exc.__cause__) + repr(exc.__context__))

        with self.assertLogs(level="DEBUG") as logs:
            logging.getLogger(pp.__name__).debug("capture start")
            attempt(pp.server_access(listener(), session_id=SID))
            attempt(pp.list_books())
            attempt(pp.book_detail("100:1"))
            attempt(pp.plex_position(listener(), "200:1", session_id=SID))
            attempt(pp.timeline(listener(), "202", "playing", 1, 2, session_id=SID))
            self.plex.timeline_down = True
            attempt(pp.timeline(listener(), "202", "playing", 1, 2, session_id=SID))
            self.plex.plextv_down = 500
            attempt(pp.server_access(listener(), session_id=SID))
            self.plex.plextv_down = "connect"
            attempt(pp.server_access(listener(), session_id=SID))
            attempt(pp.timeline(listener(), "202", "playing", 1, 2))
            self.plex.pms_down = "connect"
            attempt(pp.list_books())
            attempt(pp.assert_in_library("200:1"))
            self.plex.pms_down = 500
            attempt(pp.book_detail("200:1"))
        self.assertGreater(len(logs.records), 3)
        self.assertGreater(len(errors), 3)
        for rec in logs.records:
            text = rec.getMessage() + (logging.Formatter().formatException(rec.exc_info) if rec.exc_info else "")
            for tok in TOKENS:
                self.assertNotIn(tok, text)
        for text in errors:
            for tok in TOKENS:
                self.assertNotIn(tok, text)


if __name__ == "__main__":
    unittest.main()
