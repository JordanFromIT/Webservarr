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
                     ("The Lantern Keeper and the Last Door - Ann Reader",
                      "The Lantern Keeper and the Last Door, Book 7 - Ann Reader")):
            with self.subTest(a=a, b=b):
                self.assertFalse(pp._disc_siblings(a, b))

    def test_durations_outside_tolerance_are_not_copies(self):
        # 2.5 s apart on a 100 s part: over max(2 s, 1%).
        tracks = [disc_track(1, 1, 100_000, "B/A"), disc_track(2, 1, 102_500, "B/B")]
        self.assertEqual(self.keys(tracks), ["1", "2"])

    def test_a_huge_digit_run_in_a_folder_name_is_no_error(self):
        # T5N1: _disc_parts and _natural call int() on digit runs taken from
        # folder names; a run past int()'s digit limit (4300) would be a
        # ValueError, a 500 on list_books. Two folders sharing a track index
        # force _pick_copy through _disc_siblings (_disc_parts) and the
        # natural sort (_natural).
        huge = "9" * 5000
        tracks = [disc_track(1, 1, 100_000, f"Rip/CD{huge}"), disc_track(2, 1, 100_000, f"Rip/CD{huge}2")]
        self.keys(tracks)  # must not raise
        self.assertIsNotNone(pp._disc_parts(f"Rip/CD{huge}"))
        self.assertIsNotNone(pp._natural(f"Rip/CD{huge}"))

    def test_digits_that_are_not_ascii_are_text_not_numbers(self):
        # T1M4: "²" passes str.isdigit() but int() raises on it (a 500 at the
        # base); "٣" passes both and was read as 3. Only the split's own
        # ASCII runs are numbers.
        self.assertEqual(pp._natural("²"), ((1, 0, "²"),))
        self.assertEqual(pp._natural("٣"), ((1, 0, "٣"),))
        self.assertEqual(sorted(["٣", "10", "2", "²"], key=pp._natural), ["2", "10", "²", "٣"])

    def test_natural_sort_order_for_ordinary_names_is_unchanged(self):
        # T5N1: capping the digit run at 6 must not change how real names sort.
        names = ["Rip/CD2", "Rip/CD10", "Rip/CD1", "Rip/CD9"]
        self.assertEqual(sorted(names, key=pp._natural), ["Rip/CD1", "Rip/CD2", "Rip/CD9", "Rip/CD10"])
        self.assertTrue(pp._disc_siblings("Book Title - CD3", "Book Title - CD4"))

    # Spec 2.6 s6 (FR-N1): a digit run compares by value, at any length:
    # leading zeros stripped, then by length, then by the digits.

    def test_numbers_of_seven_digits_or_more_sort_by_value(self):
        self.assertEqual(sorted(["Track 1000000", "Track 999999"], key=pp._natural),
                         ["Track 999999", "Track 1000000"])
        self.assertEqual(sorted(["x/0001000000", "x/999999", "x/12345678", "x/02"], key=pp._natural),
                         ["x/02", "x/999999", "x/0001000000", "x/12345678"])
        # Leading zeros alone never order two names ("01" and "1" tie, as before).
        self.assertEqual(pp._natural("CD01")[:2], pp._natural("CD1")[:2])

    def test_a_100000_digit_run_does_not_raise_and_sorts_by_value(self):
        huge = "1" + "0" * 99_999                   # 100000 digits
        shorter = "9" * 99_999
        key = pp._natural(f"Part {huge}")           # far past int()'s 4300-digit limit
        self.assertIsNotNone(key)
        self.assertEqual(sorted([f"Part {huge}", f"Part {shorter}", "Part 7"], key=pp._natural),
                         ["Part 7", f"Part {shorter}", f"Part {huge}"])

    def test_natural_sort_fuzz_keeps_the_old_order_and_orders_long_runs_by_value(self):
        import random
        import re as _re

        def old(text):          # _natural as it was at f1b897b
            return tuple((0, int(p), "") if p.isdigit() else (1, 0, p.casefold())
                         for p in _re.split(r"([0-9]{1,6})", text) if p)

        def by_value(text):     # the reference for any length (int() is fine up to 4300 digits)
            return tuple((0, int(p), "") if p.isdigit() else (1, 0, p.casefold())
                         for p in _re.split(r"([0-9]+)", text) if p)

        rng = random.Random(20261003)
        pieces = ["CD", "Disc ", "Part", "Track", " - ", "_", ".", "/", "a", "B", "chapter ", " ", "(", ")"]

        def name(max_digits):
            out = []
            for _ in range(rng.randint(1, 5)):
                out.append(rng.choice(pieces))
                if rng.random() < 0.8:
                    out.append("".join(rng.choice("0123456789") for _ in range(rng.randint(1, max_digits))))
            return "".join(out)

        for _round in range(300):
            short = [name(6) for _ in range(12)]
            self.assertEqual(sorted(short, key=pp._natural), sorted(short, key=old), short)
            long = [name(14) for _ in range(12)]
            self.assertEqual(sorted(long, key=pp._natural), sorted(long, key=by_value), long)


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

    def test_it_returns_the_album_it_read(self):
        self.assertEqual(self.run_async(pp.assert_in_library("200:1"))["ratingKey"], "200")
        self.assertEqual(self.run_async(pp.assert_in_library("200:1", track_key="202"))["title"],
                         ALBUMS["200"]["title"])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class WorkKeys(unittest.TestCase):
    """Spec 2.5: a work key names the book apart from its files, so an edition,
    format or narration named in the title does not change it."""

    AUTHOR = "Wren Hollis"
    TITLE = "The Lantern Keeper's Daughter"

    def test_edition_format_and_narrator_suffixes_give_the_same_key(self):
        base = pp.work_key(self.AUTHOR, self.TITLE)
        self.assertRegex(base, r"^[0-9a-f]{32}$")
        for title in (f"{self.TITLE} (Full-Cast Edition)",
                      f"{self.TITLE} - Read by Tamsin Ashby", f"{self.TITLE} (Narrated by Tamsin Ashby)",
                      f"{self.TITLE} [Unabridged]", f"{self.TITLE}: Unabridged", f"{self.TITLE} Unabridged",
                      f"{self.TITLE} (Dramatized Adaptation)", f"{self.TITLE} [m4b]",
                      "the lantern keepers daughter", "THE LANTERN KEEPER’S DAUGHTER",
                      f"  {self.TITLE}  (Full Cast Audio Edition) "):
            with self.subTest(title=title):
                self.assertEqual(pp.work_key(self.AUTHOR, title), base)
        self.assertEqual(pp.work_key("wren  hollis.", self.TITLE), base)

    def test_a_dash_name_goes_only_when_it_is_the_books_narrator(self):
        base = pp.work_key(self.AUTHOR, self.TITLE, "Tamsin Ashby")
        self.assertEqual(base, pp.work_key(self.AUTHOR, self.TITLE))
        for title, narrator in ((f"{self.TITLE} - Tamsin Ashby", "Tamsin Ashby"),
                                (f"{self.TITLE} - Tamsin Ashby", "tamsin  ashby."),
                                (f"{self.TITLE} (Unabridged) - Tamsin Ashby", "Tamsin Ashby"),
                                (f"{self.TITLE} – J.R. Oakes-Pell", "J.R. Oakes-Pell")):
            with self.subTest(title=title, narrator=narrator):
                self.assertEqual(pp.work_key(self.AUTHOR, title, narrator), base)
        # Not the narrator, or no narrator known: the dash part is title.
        for narrator in ("", "Other Voice"):
            with self.subTest(narrator=narrator):
                self.assertNotEqual(pp.work_key(self.AUTHOR, f"{self.TITLE} - Tamsin Ashby", narrator), base)
        # A subtitle that looks like a name is never guessed to be one.
        self.assertNotEqual(pp.work_key(self.AUTHOR, "Saga - Iron Crown"), pp.work_key(self.AUTHOR, "Saga - Silver Tide"))
        self.assertNotEqual(pp.work_key(self.AUTHOR, "Saga - Iron Crown", "Dee Lane"),
                            pp.work_key(self.AUTHOR, "Saga - Silver Tide", "Dee Lane"))

    def test_different_authors_or_books_give_different_keys(self):
        base = pp.work_key(self.AUTHOR, self.TITLE)
        self.assertNotEqual(pp.work_key("Other Pennant", self.TITLE), base)
        self.assertNotEqual(pp.work_key(self.AUTHOR, "The Lantern Keeper's Son"), base)
        # The book's number is kept: book 1 and book 2 are two works.
        self.assertNotEqual(pp.work_key(self.AUTHOR, "Tide Mill, Book 1"), pp.work_key(self.AUTHOR, "Tide Mill, Book 2"))
        # A subtitle after a dash is part of the title, not a narrator.
        for a, b in (("Tide Mill - The Return", "Tide Mill - The Arrival"),
                     ("Tide Mill - Second Voyage", "Tide Mill - Third Voyage"),
                     ("Tide Mill - Part One", "Tide Mill - Part Two"),
                     ("Tide Mill (Book 2)", "Tide Mill (Book 3)")):
            with self.subTest(a=a, b=b):
                self.assertNotEqual(pp.work_key(self.AUTHOR, a), pp.work_key(self.AUTHOR, b))

    def test_a_copy_part_that_holds_the_books_number_keeps_it(self):
        # T1B1: book 2 and book 3 never share a key, whatever copy words
        # ride in the same part.
        for a, b in (("Tide Mill (Book 2, Unabridged)", "Tide Mill (Book 3, Unabridged)"),
                     ("Tide Mill (Book 2 - Full-Cast Edition)", "Tide Mill (Book 3 - Full-Cast Edition)"),
                     ("Tide Mill [Dramatized, Book 2]", "Tide Mill [Dramatized, Book 3]"),
                     ("Tide Mill - Book 2, Dramatized", "Tide Mill - Book 3, Dramatized"),
                     ("Tide Mill - Book 2 Full Cast Edition", "Tide Mill - Book 3 Full Cast Edition"),
                     ("Tide Mill - Radio Drama, Part 1", "Tide Mill - Radio Drama, Part 2"),
                     ("Tide Mill - The Complete Radio Drama Series 1", "Tide Mill - The Complete Radio Drama Series 2"),
                     ("Tide Mill (Volume 1: Full Cast Audio Drama)", "Tide Mill (Volume 2: Full Cast Audio Drama)"),
                     ("Tide Mill (Mp3 Book 1)", "Tide Mill (Mp3 Book 2)"),
                     ("Tide Mill (Part II, Unabridged)", "Tide Mill (Part III, Unabridged)"),
                     ("Tide Mill (Unabridged #3)", "Tide Mill (Unabridged #4)"),
                     ("Tide Mill - Read by Tamsin Ashby, Book 2", "Tide Mill - Read by Tamsin Ashby, Book 3"),
                     ("Tide Mill (Narrated by Tamsin Ashby, Book 2)", "Tide Mill (Narrated by Tamsin Ashby, Book 3)"),
                     ("Tide Mill 1 (Unabridged)", "Tide Mill 2 (Unabridged)")):
            with self.subTest(a=a, b=b):
                self.assertNotEqual(pp.work_key(self.AUTHOR, a), pp.work_key(self.AUTHOR, b))
        # Only the copy words go: the numbered part matches the plain title's.
        for title in ("Tide Mill (Book 2, Unabridged)", "Tide Mill - Book 2, Dramatized",
                      "Tide Mill [Full Cast, Book 2]"):
            with self.subTest(title=title):
                self.assertEqual(pp.work_key(self.AUTHOR, title), pp.work_key(self.AUTHOR, "Tide Mill (Book 2)"))

    def test_the_books_number_is_taken_from_anywhere_in_the_title(self):
        # T1R8: every book-number phrase, in any bracket or after any
        # separator, narrator's part included, is one normalised token. A
        # volume and a number are kinds of their own (spec 2.6 s3), tested
        # in test_volume_book_and_number_are_different_kinds.
        book2 = pp.work_key(self.AUTHOR, "Tide Mill (Book 2)")
        for title in ("Tide Mill, Book 2", "Tide Mill - Read by Tamsin Ashby, Book 2, Unabridged",
                      "Tide Mill - Read by Tamsin Ashby [Book 2]", "Tide Mill - Read by Tamsin Ashby #2",
                      "Tide Mill (Narrated by Tamsin Ashby, Book 2)", "Tide Mill, Book 2 - Read by Tamsin Ashby",
                      "Tide Mill, Book II", "Tide Mill, Book Two", "Tide Mill, Bk. 2",
                      "Tide Mill #2", "Tide Mill, Book #2", "Tide Mill, Book 02", "Tide Mill {Book 2}",
                      "Tide Mill (Unabridged) (Book 2)", "Tide Mill (Book 2) (Unabridged)"):
            with self.subTest(title=title):
                self.assertEqual(pp.work_key(self.AUTHOR, title), book2)
        self.assertEqual(pp._work_title("Tide Mill - Read by Tamsin Ashby, Book II, Unabridged"), "tide mill #2")
        self.assertEqual(pp._work_title("Tide Mill, Book 3 [Part 1]"), "tide mill #3 +1")
        # Not a book number: inside a word, a bare number, or letters that
        # aren't a Roman numeral. Those stay as words.
        for a, b in (("Tide Mill Notebook 2", "Tide Mill Notebook 3"), ("Tide Mill 2", "Tide Mill 3"),
                     ("Tide Mill, Book 2.5", "Tide Mill, Book 2"), ("Tide Mill Part Lil", "Tide Mill"),
                     ("Tide Mill, Book 2nd Edition", "Tide Mill, Book 3rd Edition")):
            with self.subTest(a=a, b=b):
                self.assertNotEqual(pp.work_key(self.AUTHOR, a), pp.work_key(self.AUTHOR, b))

    def test_book_n_of_m_is_book_n(self):
        # T2K3: a re-rip may name the size of the set or not; the book is the
        # same. (A part keeps its "of M": "Part 1 of 2" is not "Part 1 of 3".)
        for title in ("Tide Mill, Book 2 of 5", "Tide Mill, Book Two of Five", "Tide Mill - Read by Tamsin Ashby, Book 2 of 5",
                      "Tide Mill (Book 2 of 5, Unabridged)", "Tide Mill, Book 2 of 12"):
            with self.subTest(title=title):
                self.assertEqual(pp.work_key(self.AUTHOR, title), pp.work_key(self.AUTHOR, "Tide Mill, Book 2"))
        self.assertEqual(pp._work_title("Tide Mill, Book 2 of 5"), "tide mill #2")
        self.assertEqual(pp._work_title("Tide Mill, Vol. 2 of 5"), "tide mill %2")
        self.assertNotEqual(pp.work_key(self.AUTHOR, "Tide Mill, Part 1 of 2"), pp.work_key(self.AUTHOR, "Tide Mill, Part 1 of 3"))
        self.assertNotEqual(pp.work_key(self.AUTHOR, "Tide Mill, Book 3 of 5"), pp.work_key(self.AUTHOR, "Tide Mill, Book 2 of 5"))

    def test_copy_variants_of_a_numbered_book_share_its_key(self):
        for base in ("Tide Mill", "Tide Mill, Book 2"):
            key = pp.work_key(self.AUTHOR, base)
            for suffix in (" (Unabridged)", " - Read by Tamsin Ashby", " (Full-Cast Edition)", " [m4b]", ": A Novel",
                           " (Narrated by Tamsin Ashby)", " - Read by Tamsin Ashby, Dee Lane"):
                with self.subTest(title=base + suffix):
                    self.assertEqual(pp.work_key(self.AUTHOR, base + suffix), key)

    def test_numbers_keep_their_kind_order_and_repeats(self):
        # T1K1: a token says which phrase it came from ("#" a book: book, bk.,
        # #; "%" a volume; "@" a number; "+" a part; "/M" of M), in order,
        # repeats kept, so two different books never share a key.
        for a, b in (("Tide Mill, Book 1, Part 2", "Tide Mill, Book 2, Part 1"),
                     ("Tide Mill, Book 2 of 5", "Tide Mill, Book 5, Part 2"),
                     ("Tide Mill, Book 1 of 2", "Tide Mill, Book 2, Part 1"),
                     ("Tide Mill, Part 1 of 2", "Tide Mill, Book 2 (Part 1)"),
                     ("Tide Mill, Part 2", "Tide Mill, Book 2"),
                     ("Tide Mill, Book 2, Part 2", "Tide Mill, Book 2"),
                     ("Tide Mill, Book 2 (Part 2 of 2)", "Tide Mill, Book 2"),
                     ("Tide Mill, Vol. 1, Book 2", "Tide Mill, Vol. 2, Book 1"),
                     ("Tide Mill, Book 2 - Read by Number 3 Players", "Tide Mill, Book 3 - Read by Number 2 Players")):
            with self.subTest(a=a, b=b):
                self.assertNotEqual(pp.work_key(self.AUTHOR, a), pp.work_key(self.AUTHOR, b))
        # Spellings of one number are still one token.
        for a, b in (("Tide Mill, Vol. 2", "Tide Mill, Volume 2"), ("Tide Mill, Volume II", "Tide Mill, Vol 2"),
                     ("Tide Mill, Book 2, Part 1", "Tide Mill (Book II, Pt. 1)"),
                     ("Tide Mill, Part One of Two", "Tide Mill, Part 1 of 2")):
            with self.subTest(a=a, b=b):
                self.assertEqual(pp.work_key(self.AUTHOR, a), pp.work_key(self.AUTHOR, b))
        self.assertEqual(pp._work_title("Tide Mill, Book 2, Part 1"), "tide mill #2 +1")
        self.assertEqual(pp._work_title("Tide Mill, Book 2 (Part 1 of 2)"), "tide mill #2 +1/2")

    def test_number_words_short_forms_and_narrator_digits_count(self):
        # T1K2: "Book Two" is a number (one to twenty), Bk. and Pt. are
        # markers, and digits in the narrator's part that no phrase claims
        # ("Series 2", "Disc 2", "(2)") become tokens rather than going.
        self.assertEqual(pp.work_key(self.AUTHOR, "Tide Mill, Book Two"), pp.work_key(self.AUTHOR, "Tide Mill, Book 2"))
        for fmt in ("Tide Mill, Book {w}", "Tide Mill - Read by Tamsin Ashby, Book {w}",
                    "Tide Mill (Narrated by Tamsin Ashby, Book {w})", "Tide Mill - Read by Tamsin Ashby, Part {w}",
                    "Tide Mill - Read by Tamsin Ashby, Series {n}", "Tide Mill - Read by Tamsin Ashby, Season {n}",
                    "Tide Mill - Read by Tamsin Ashby, Disc {n}", "Tide Mill - Read by Tamsin Ashby, CD {n}",
                    "Tide Mill - Read by Tamsin Ashby, Pt. {n}", "Tide Mill - Read by Tamsin Ashby, Bk. {n}",
                    "Tide Mill - Read by Tamsin Ashby ({n})", "Tide Mill - Read by Tamsin Ashby, {n} of 5",
                    "Tide Mill - Read by Tamsin Ashby, Episode {n}", "Tide Mill (Read by Tamsin Ashby, Disc {n})",
                    "Tide Mill, Book {w} - Tamsin Ashby {n}"):
            with self.subTest(fmt=fmt):
                two, three = fmt.format(n=2, w="Two"), fmt.format(n=3, w="Three")
                self.assertNotEqual(pp.work_key(self.AUTHOR, two, "Tamsin Ashby 2"),
                                    pp.work_key(self.AUTHOR, three, "Tamsin Ashby 3"))
        self.assertEqual(pp._work_title("Tide Mill - Read by Tamsin Ashby, Series 2"), "tide mill ^series2")
        self.assertEqual(pp._work_title("Tide Mill, Bk. 2, Pt. 3"), "tide mill #2 +3")
        # A narrator whose name holds a digit keeps it in the key, the same
        # however the narration is written: a split from a copy that doesn't
        # name them, never a collision.
        self.assertEqual(pp.work_key(self.AUTHOR, "Tide Mill - Read by BBC Radio 4 Full Cast"),
                         pp.work_key(self.AUTHOR, "Tide Mill (Narrated by BBC Radio 4 Full Cast)"))
        self.assertNotEqual(pp.work_key(self.AUTHOR, "Tide Mill - Read by BBC Radio 4 Full Cast"),
                            pp.work_key(self.AUTHOR, "Tide Mill"))

    def test_a_part_that_held_a_number_is_kept_less_its_copy_words(self):
        # T1K3: a phrase taken out leaves a mark, so its bracket or dash part
        # still counts as numbered: the rest of it stays, only copy words go.
        for a, b in (("The Iron Crown (Tide Mill Saga, Book 2, Unabridged)", "The Iron Crown (Tide Mill Saga, Book 2)"),
                     ("The Iron Crown (Tide Mill Saga, Book 2, Unabridged)", "The Iron Crown: Tide Mill Saga, Book 2"),
                     ("The Iron Crown [Tide Mill Saga, Book 2, Unabridged]",
                      "The Iron Crown (Tide Mill Saga, Book 2) [Unabridged]"),
                     ("The Iron Crown - Tide Mill Saga, Book 2, Unabridged Edition",
                      "The Iron Crown - Tide Mill Saga, Book 2"),
                     ("The Iron Crown (Tide Mill Saga #2, Unabridged)", "The Iron Crown (Tide Mill Saga #2)"),
                     ("The Iron Crown (Tide Mill Saga, Book 2, Full-Cast Edition)",
                      "The Iron Crown (Tide Mill Saga, Book 2)"),
                     ("Tide Mill (Book 2, Unabridged)", "Tide Mill (Book 2)"),
                     # A mark left at the very end hides nothing before it.
                     ("Tide Mill (Narrated by Tamsin Ashby) Book 2", "Tide Mill, Book 2"),
                     ("Tide Mill (Unabridged) (Book 2, Unabridged)", "Tide Mill, Book 2")):
            with self.subTest(a=a, b=b):
                self.assertEqual(pp.work_key(self.AUTHOR, a), pp.work_key(self.AUTHOR, b))
        for a, b in (("Tide Mill (Book 2, Side A, Unabridged)", "Tide Mill (Book 2, Side B, Unabridged)"),
                     ("Tide Mill (Book 2, Disc One, Unabridged)", "Tide Mill (Book 2, Disc Two, Unabridged)"),
                     ("Tide Mill (Book 2: The Iron Crown, Unabridged)", "Tide Mill (Book 2: The Silver Tide, Unabridged)")):
            with self.subTest(a=a, b=b):
                self.assertNotEqual(pp.work_key(self.AUTHOR, a), pp.work_key(self.AUTHOR, b))

    def test_decimals_are_kept_exactly(self):
        # T1K5: "2.1" and "2.10" are two books; a leading zero is not a digit
        # of the number.
        for a, b in (("Tide Mill, Book 2.1", "Tide Mill, Book 2.10"), ("Tide Mill, Book 1.5", "Tide Mill, Book 1.50"),
                     ("Tide Mill, Book 2.5", "Tide Mill, Book 2, Part 5")):
            with self.subTest(a=a, b=b):
                self.assertNotEqual(pp.work_key(self.AUTHOR, a), pp.work_key(self.AUTHOR, b))
        self.assertEqual(pp.work_key(self.AUTHOR, "Tide Mill, Book 02.5"), pp.work_key(self.AUTHOR, "Tide Mill, Book 2.5"))

    def test_spellings_of_one_title_are_folded(self):
        # T1B2: accents, full-width forms, "&", "A Novel" and apostrophe variants.
        import unicodedata
        for a, b in (("Les Mis\u00e9rables", "Les Miserables"),
                     ("Les Mis\u00e9rables", unicodedata.normalize("NFD", "Les Mis\u00e9rables")),
                     ("Tide Mill", "\uff34\uff49\uff44\uff45 \uff2d\uff49\uff4c\uff4c"),
                     ("Tide Mill, Book 2", "Tide Mill, Book \uff12"),
                     ("Salt & Pepper", "Salt and Pepper"),
                     ("Tide Mill", "Tide Mill: A Novel"), ("Tide Mill", "Tide Mill (A Novel)"),
                     ("Tide Mill", "Tide Mill - A Novel"),
                     ("Keeper's Daughter", "Keeper\u02bcs Daughter"), ("Keeper's Daughter", "Keeper\u00b4s Daughter"),
                     ("Keeper's Daughter", "Keeper`s Daughter"), ("Keeper's Daughter", "Keeper\u2019s Daughter")):
            with self.subTest(a=a, b=b):
                self.assertEqual(pp.work_key(self.AUTHOR, a), pp.work_key(self.AUTHOR, b))
        self.assertEqual(pp.work_key("Ren\u00e9e Ash & Co", "Tide Mill"), pp.work_key("Renee Ash and Co", "Tide Mill"))
        # "A Novel" goes only as the whole part.
        self.assertNotEqual(pp.work_key(self.AUTHOR, "Tide Mill - A Novel Approach"),
                            pp.work_key(self.AUTHOR, "Tide Mill - A Novel Beginning"))

    def test_a_novel_goes_only_after_a_separator(self):
        # T1R2: "How to Write a Novel" is its own title.
        self.assertNotEqual(pp.work_key(self.AUTHOR, "How to Write a Novel"), pp.work_key(self.AUTHOR, "How to Write"))
        self.assertNotEqual(pp.work_key(self.AUTHOR, "Tide Mill A Novel"), pp.work_key(self.AUTHOR, "Tide Mill"))
        for title in ("Tide Mill: A Novel", "Tide Mill, A Novel", "Tide Mill; A Novel", "Tide Mill - A Novel",
                      "Tide Mill \u2013 A Novel", "Tide Mill (A Novel)"):
            with self.subTest(title=title):
                self.assertEqual(pp.work_key(self.AUTHOR, title), pp.work_key(self.AUTHOR, "Tide Mill"))

    def test_a_huge_run_of_digits_in_a_dropped_part_is_no_error(self):
        # T1Z2: a run past int()'s digit limit (4300) would be a ValueError, a
        # 500 on every check-in and /position for the book.
        huge = "9" * 5000
        for title in (f"Tide Mill - Read by Radio {huge} Players", f"Tide Mill (Narrated by X, Series {huge}.{huge})"):
            with self.subTest(title=title[:40]):
                key = pp.work_key(self.AUTHOR, title)
                self.assertRegex(key, r"^[0-9a-f]{32}$")
                self.assertNotEqual(key, pp.work_key(self.AUTHOR, "Tide Mill"))
        album = dict(ALBUMS["500"], title=f"Quiet Book - Read by Radio {huge} Players")
        with mock.patch.dict(ALBUMS, {"500": album}):
            self.assertRegex(pp.album_work_key(album), r"^[0-9a-f]{32}$")
        # Ordinary narrator digits are tokens as before.
        self.assertEqual(pp._dropped_numbers("Read by Radio 4 Players, Series 2.5"), ["^radio4", "^series2.5"])

    # --- Spec 2.6 s3: the 2.5 parked matcher items, one test each ---

    def test_volume_book_and_number_are_different_kinds(self):
        # 2.5 parked: Vol./Book/No. shared one kind, so "Vol. 2" was "Book 2".
        # Each is a kind of its own now; spellings within a kind still agree.
        for a, b in (("Tide Mill, Vol. 2", "Tide Mill, Book 2"), ("Tide Mill, Volume II", "Tide Mill, Book II"),
                     ("Tide Mill, No. 2", "Tide Mill, Book 2"), ("Tide Mill, Number 2", "Tide Mill, Vol. 2"),
                     ("Tide Mill, Vol. 1, Book 2", "Tide Mill, Book 1, Vol. 2"),
                     ("Tide Mill - Read by Tamsin Ashby, Vol. 2", "Tide Mill - Read by Tamsin Ashby, Book 2"),
                     ("Tide Mill (Vol. 2, Unabridged)", "Tide Mill (No. 2, Unabridged)")):
            with self.subTest(a=a, b=b):
                self.assertNotEqual(pp.work_key(self.AUTHOR, a), pp.work_key(self.AUTHOR, b))
        for a, b in (("Tide Mill, Vol. 2", "Tide Mill, Volume II"), ("Tide Mill, Vol 2", "Tide Mill, Volume Two"),
                     ("Tide Mill, No. 2", "Tide Mill, Number 2"), ("Tide Mill, No 2", "Tide Mill No.2"),
                     ("Tide Mill, Book 2", "Tide Mill, Bk. 2"), ("Tide Mill, Book 2", "Tide Mill #2")):
            with self.subTest(a=a, b=b):
                self.assertEqual(pp.work_key(self.AUTHOR, a), pp.work_key(self.AUTHOR, b))
        self.assertEqual(pp._work_title("Tide Mill, Vol. 1, Book 2, No. 3, Part 4"), "tide mill %1 #2 @3 +4")

    def test_number_words_to_twenty_ordinals_and_roman_numerals_are_the_same_number(self):
        roman = "I II III IV V VI VII VIII IX X XI XII XIII XIV XV XVI XVII XVIII XIX XX".split()
        words = ("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
                 "sixteen seventeen eighteen nineteen twenty").split()
        ordinals = ("first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth "
                    "thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth").split()
        suffixes = {1: "st", 2: "nd", 3: "rd"}
        for n in range(1, 21):
            suffix = "th" if n // 10 == 1 else suffixes.get(n % 10, "th")
            spellings = [f"Book {n}", f"Book {roman[n - 1]}", f"Book {words[n - 1]}", f"Book {ordinals[n - 1]}",
                         f"Book {n}{suffix}", f"{ordinals[n - 1].title()} Book", f"{n}{suffix} Book",
                         f"Book {words[n - 1].title()}"]
            keys = {pp.work_key(self.AUTHOR, f"Tide Mill, {s}") for s in spellings}
            with self.subTest(n=n):
                self.assertEqual(len(keys), 1, spellings)
        # Every one of them a different book from the next.
        self.assertEqual(len({pp.work_key(self.AUTHOR, f"Tide Mill, Book {w}") for w in words}), 20)
        self.assertEqual(pp._work_title("Tide Mill, Second Volume"), "tide mill %2")
        self.assertEqual(pp._work_title("Tide Mill, 3rd Part of 5"), "tide mill +3/5")

    def test_numbers_after_a_non_marker_word_in_the_narrators_part_are_kept(self):
        # 2.5 parked: a number word, Roman numeral or ordinal after a word
        # that isn't a marker was dropped with the narrator's part ("Read by
        # X, Two" and "Read by X, Three" were one book).
        for two, three in (("Tide Mill - Read by Tamsin Ashby, Two", "Tide Mill - Read by Tamsin Ashby, Three"),
                           ("Tide Mill - Read by Tamsin Ashby, II", "Tide Mill - Read by Tamsin Ashby, III"),
                           ("Tide Mill - Read by Tamsin Ashby, Second", "Tide Mill - Read by Tamsin Ashby, Third"),
                           ("Tide Mill - Read by Tamsin Ashby, 2nd", "Tide Mill - Read by Tamsin Ashby, 3rd"),
                           ("Tide Mill - Read by Tamsin Ashby, Series Two", "Tide Mill - Read by Tamsin Ashby, Series Three"),
                           ("Tide Mill (Narrated by Tamsin Ashby, Season II)", "Tide Mill (Narrated by Tamsin Ashby, Season III)"),
                           ("Tide Mill - Read by Tamsin Ashby (Second Series)", "Tide Mill - Read by Tamsin Ashby (Third Series)"),
                           ("Tide Mill - Read by Radio Four Players", "Tide Mill - Read by Radio Five Players"),
                           ("Tide Mill - Tamsin Ashby II", "Tide Mill - Tamsin Ashby III")):
            with self.subTest(two=two):
                narrator = "Tamsin Ashby II" if "Tamsin Ashby II" in two else ""
                other = "Tamsin Ashby III" if narrator else ""
                self.assertNotEqual(pp.work_key(self.AUTHOR, two, narrator), pp.work_key(self.AUTHOR, three, other))
        # The same number written two ways in that part is one token.
        self.assertEqual(pp.work_key(self.AUTHOR, "Tide Mill - Read by Tamsin Ashby, Two"),
                         pp.work_key(self.AUTHOR, "Tide Mill - Read by Tamsin Ashby, 2"))
        self.assertEqual(pp.work_key(self.AUTHOR, "Tide Mill - Read by Tamsin Ashby, Series Two"),
                         pp.work_key(self.AUTHOR, "Tide Mill - Read by Tamsin Ashby, Series 2"))
        # An initial is not a Roman numeral; a narrator without a number is no token.
        self.assertEqual(pp.work_key(self.AUTHOR, "Tide Mill - Read by Eric V. Smith"), pp.work_key(self.AUTHOR, "Tide Mill"))
        self.assertEqual(pp._work_title("Tide Mill - Read by Tamsin Ashby, I"), "tide mill ^1")

    def test_a_number_in_the_narrators_part_keeps_what_it_counts(self):
        # 2.5 parked: "Series 2" and "Disc 2" were both "n2".
        for a, b in (("Series 2", "Disc 2"), ("Disc 2", "CD 2"), ("Season 2", "Episode 2"), ("Radio 4", "Series 4"),
                     ("Series 2", "2"), ("Series 2", "Series 3")):
            with self.subTest(a=a, b=b):
                self.assertNotEqual(pp.work_key(self.AUTHOR, f"Tide Mill - Read by Tamsin Ashby, {a}"),
                                    pp.work_key(self.AUTHOR, f"Tide Mill - Read by Tamsin Ashby, {b}"))
        self.assertEqual(pp._dropped_numbers("Read by BBC Radio 4 Full Cast, Series Two, 3rd Disc"),
                         ["^radio4", "^series2", "^3", "^~disc"])
        self.assertEqual(pp._dropped_numbers("Read by Tamsin Ashby"), [])

    def test_a_copy_part_whose_only_number_is_a_word_is_kept(self):
        # 2.5 parked: "(Two, Unabridged)" was a copy part with no digit, so it
        # went whole, and book Two and book Three shared a key.
        for a, b in (("Tide Mill (Two, Unabridged)", "Tide Mill (Three, Unabridged)"),
                     ("Tide Mill (Second, Unabridged)", "Tide Mill (Third, Unabridged)"),
                     ("Tide Mill [Dramatized, Two]", "Tide Mill [Dramatized, Three]"),
                     ("Tide Mill - Two, Full Cast Edition", "Tide Mill - Three, Full Cast Edition"),
                     ("Tide Mill (Unabridged, XII)", "Tide Mill (Unabridged, XIII)")):
            with self.subTest(a=a, b=b):
                self.assertNotEqual(pp.work_key(self.AUTHOR, a), pp.work_key(self.AUTHOR, b))
        # Only the copy words go.
        self.assertEqual(pp.work_key(self.AUTHOR, "Tide Mill (Two, Unabridged)"), pp.work_key(self.AUTHOR, "Tide Mill (Two)"))

    def test_a_token_is_never_a_word_of_a_title(self):
        # 2.5 parked: tokens were letters and digits ("p1", "n2"), so a title
        # that was spelt like one collided with the phrase that made it.
        for title, phrase in (("Tide Mill P1", "Tide Mill, Part 1"), ("Tide Mill p2", "Tide Mill, Pt. 2"),
                              ("Tide Mill N2", "Tide Mill - Read by Tamsin Ashby, Series 2"),
                              ("Tide Mill n2", "Tide Mill - Read by Tamsin Ashby, 2"),
                              ("Tide Mill B2", "Tide Mill, Book 2"), ("Tide Mill 2", "Tide Mill, Book 2"),
                              ("Tide Mill v2", "Tide Mill, Vol. 2"), ("Tide Mill _1", "Tide Mill, Book 1")):
            with self.subTest(title=title):
                self.assertNotEqual(pp.work_key(self.AUTHOR, title), pp.work_key(self.AUTHOR, phrase))

    def test_different_books_never_share_a_key_across_the_ways_a_number_is_written(self):
        # A sweep across the formats: book, volume, number and part, 1 to 4,
        # as digits, words, Roman numerals and ordinals, in the title, in
        # brackets and in the narrator's part. A key belongs to one book.
        roman, words = ("I", "II", "III", "IV"), ("One", "Two", "Three", "Four")
        ordinals, suffixed = ("First", "Second", "Third", "Fourth"), ("1st", "2nd", "3rd", "4th")
        kinds = {"book": ("Book {n}", "Bk. {n}", "Book {w}", "Book {r}", "Book {o}", "Book {s}", "{o} Book", "#{n}"),
                 "vol": ("Vol. {n}", "Volume {n}", "Volume {r}", "Volume {w}", "{o} Volume"),
                 "no": ("No. {n}", "Number {n}", "Number {w}", "No. {r}"),
                 "part": ("Part {n}", "Pt. {n}", "Part {r}", "Part {w}", "{o} Part")}
        wraps = ("Tide Mill - Read by Tamsin Ashby, {p}", "Tide Mill (Narrated by Tamsin Ashby, {p})",
                 "Tide Mill - Read by Tamsin Ashby [{p}]", "Tide Mill, {p}", "Tide Mill ({p})", "Tide Mill - {p}",
                 "Tide Mill ({p}, Unabridged)", "Tide Mill (Unabridged) ({p})", "Tide Mill, {p} - Read by Tamsin Ashby")
        owner = {}
        for wrap in wraps:
            for kind, phrases in kinds.items():
                for phrase in phrases:
                    for n in range(1, 5):
                        title = wrap.format(p=phrase.format(n=n, r=roman[n - 1], w=words[n - 1], o=ordinals[n - 1],
                                                            s=suffixed[n - 1]))
                        self.assertEqual(owner.setdefault(pp.work_key(self.AUTHOR, title), (kind, n)), (kind, n), title)

    # --- Spec 2.6, fix round 1: T2K1 to T2K3 ---

    def test_no_digit_symbol_can_make_a_work_key_raise(self):
        # T2K1: str.isdigit() is true for symbols no int() can read (❶, ⓵, ፩, ²).
        # None of them is an error in any part of a title, and a decimal digit
        # of another script is that digit.
        import sys
        digits = [chr(c) for c in range(sys.maxunicode + 1) if chr(c).isdigit()]
        self.assertGreater(len(digits), 600)
        for c in digits:
            for fmt in ("Tide Mill - Read by Tamsin Ashby, Book {c}", "Tide Mill - Read by Tamsin Ashby, Series {c}",
                        "Tide Mill (Narrated by {c})", "Tide Mill, Book {c}", "Tide Mill ({c}, Unabridged)",
                        "Tide Mill - {c}"):
                try:
                    key = pp.work_key(self.AUTHOR, fmt.format(c=c))
                except Exception as exc:  # noqa: BLE001
                    self.fail(f"U+{ord(c):04X} in {fmt!r}: {exc!r}")
                self.assertRegex(key, r"^[0-9a-f]{32}$")
        import unicodedata
        two = next(c for c in digits if unicodedata.decimal(c, None) == 2 and not c.isascii())
        self.assertEqual(pp.work_key(self.AUTHOR, f"Tide Mill - Read by Tamsin Ashby, Series {two}"),
                         pp.work_key(self.AUTHOR, "Tide Mill - Read by Tamsin Ashby, Series 2"))
        self.assertEqual(pp.work_key(self.AUTHOR, f"Tide Mill, Book {two}"), pp.work_key(self.AUTHOR, "Tide Mill, Book 2"))
        self.assertIsNone(pp._number_token("\u2776"))
        self.assertIsNone(pp._number_token("\u2488"))
        # A symbol with no decimal value is a word: books marked ❶ and ❷ differ.
        self.assertNotEqual(pp.work_key(self.AUTHOR, "Tide Mill - Read by Tamsin Ashby, Book \u2776"),
                            pp.work_key(self.AUTHOR, "Tide Mill - Read by Tamsin Ashby, Book \u2777"))

    def test_a_title_no_key_can_be_made_of_is_a_book_with_no_key_not_an_error(self):
        album = dict(ALBUMS["500"], title="Quiet Book")
        children = {"Metadata": TRACKS["500"]}
        boom = mock.Mock(side_effect=ValueError("boom"))
        with mock.patch.object(pp, "_work_title", boom):
            out = pp._identity(album, 1, children)
            self.assertIsNone(out["work_key"])
            self.assertEqual(out["author"], "Ann Author")
            self.assertEqual(out["duration_ms"], 90_000)
            self.assertIsNone(pp.album_work_key(album))

    def test_the_narration_keeps_everything_but_the_narrators_name(self):
        # T2K2: numbers of any size, numbers of other scripts, letters, Roman
        # numerals and text after the narrator are kept, so these are never one book.
        base = "Tide Mill - Read by Tamsin Ashby"
        for a, b in ((f"{base}, Book Thirty", f"{base}, Book Forty"),
                     (f"{base}, Book Thirty-One", f"{base}, Book Forty-One"),
                     (f"{base}, Book One Hundred", f"{base}, Book 1"),
                     (f"{base}, Book One Hundred and One", f"{base}, Book One Hundred"),
                     (f"{base}, Series Two Thousand", f"{base}, Series Two"),
                     (f"{base}, Book \u0662", f"{base}, Book \u0663"),
                     (f"{base}, Series V.", f"{base}, Series X."),
                     (f"{base}, Series LI", f"{base}, Series LII"),
                     (f"{base}, Series LL", f"{base}, Series LLI"),
                     (f"{base}, Part A", f"{base}, Part B"),
                     (f"{base}, A", f"{base}, B"),
                     (f"{base}, Collection 3", f"{base}, Level 3"),
                     (f"{base}, Year 3", f"{base}, Level 3"),
                     (f"{base}: Winter", f"{base}: Summer"),
                     (f"{base} - Winter", f"{base} - Summer"),
                     (f"{base}) (Winter", f"{base}) (Summer"),
                     ("Tide Mill (Narrated by Tamsin Ashby) (Winter)", "Tide Mill (Narrated by Tamsin Ashby) (Summer)"),
                     ("Tide Mill (LL, Unabridged)", "Tide Mill (LLI, Unabridged)"),
                     ("Tide Mill (Thirty, Unabridged)", "Tide Mill (Forty, Unabridged)"),
                     ("Tide Mill (A, Unabridged)", "Tide Mill (B, Unabridged)")):
            with self.subTest(a=a, b=b):
                self.assertNotEqual(pp.work_key(self.AUTHOR, a), pp.work_key(self.AUTHOR, b))
        # The name itself, a co-narrator, an initial and copy words are not kept.
        for title in (f"{base}, Dee Lane", f"{base}, Dee Lane, Unabridged", "Tide Mill - Read by Eric V. Smith",
                      "Tide Mill - Read by J. K. Smith", f"{base}: Unabridged", f"{base} (Unabridged)"):
            with self.subTest(title=title):
                self.assertEqual(pp.work_key(self.AUTHOR, title), pp.work_key(self.AUTHOR, "Tide Mill"))
        self.assertEqual(pp._number_run("one hundred and twenty five".split(), 0), (125, 5))
        self.assertEqual(pp._number_run("forty one".split(), 0), (41, 2))
        self.assertEqual(pp._number_run("two thousand five hundred".split(), 0), (2500, 4))

    def test_only_latin_accents_are_folded(self):
        # T2K2: kana voicing and Cyrillic letters are not accents.
        for a, b in (("\u304b\u304d", "\u304b\u304e"), ("\u30ac", "\u30ab"), ("\u0439", "\u0438"),
                     ("Tide Mill \u0439", "Tide Mill \u0438")):
            with self.subTest(a=a, b=b):
                self.assertNotEqual(pp.work_key(self.AUTHOR, a), pp.work_key(self.AUTHOR, b))
        self.assertEqual(pp.work_key(self.AUTHOR, "Les Mis\u00e9rables"), pp.work_key(self.AUTHOR, "Les Miserables"))
        self.assertEqual(pp.work_key(self.AUTHOR, "\u304b\u304e"), pp.work_key(self.AUTHOR, "\u304b\u304d\u3099"))

    def test_a_rerips_noise_does_not_split_the_book(self):
        # T2K3: a year, a format or bitrate tag, an ASIN, "(Unabridged)" wherever it
        # falls, leading zeros and the size of the set.
        for base in ("Tide Mill", "Tide Mill, Book 2"):
            key = pp.work_key(self.AUTHOR, base)
            for suffix in (" (2019)", " [2019]", " (Unabridged, 2019)", " [64kbps]", " (128 kbps)", " [MP3 64kbps]",
                           " (M4B, 64k)", " [mp3-320]", " [B07XYZ1234]", " [ASIN B07XYZ1234]", " (ASIN: B07XYZ1234)",
                           " (Unabridged) [MP3]", " (Unabridged) (2019)", " [Unabridged] [mp3-320] (2019)"):
                with self.subTest(title=base + suffix):
                    self.assertEqual(pp.work_key(self.AUTHOR, base + suffix), key)
        for suffix in (" (Full-Cast Edition, 2019)", " (Dramatized, 128 kbps)", " [Full Cast, B07XYZ1234]",
                       " (Full-Cast Edition) (2019)"):
            with self.subTest(suffix=suffix):
                self.assertEqual(pp.work_key(self.AUTHOR, "Tide Mill" + suffix), pp.work_key(self.AUTHOR, "Tide Mill"))
        key = pp.work_key(self.AUTHOR, "Tide Mill: The Rising")
        for title in ("Tide Mill (Unabridged): The Rising", "Tide Mill (Unabridged) - The Rising",
                      "Tide Mill [Unabridged]: The Rising (2019)"):
            with self.subTest(title=title):
                self.assertEqual(pp.work_key(self.AUTHOR, title), key)
        self.assertEqual(pp.work_key(self.AUTHOR, "Tide Mill 02"), pp.work_key(self.AUTHOR, "Tide Mill 2"))
        self.assertEqual(pp.work_key(self.AUTHOR, "Tide Mill 007"), pp.work_key(self.AUTHOR, "Tide Mill 7"))
        self.assertNotEqual(pp.work_key(self.AUTHOR, "Tide Mill 2.01"), pp.work_key(self.AUTHOR, "Tide Mill 2.1"))
        self.assertEqual(pp._work_title("Tide Mill 0"), "tide mill 0")

    def test_other_productions_and_other_numbers_still_split(self):
        # T2K3: a year-like or number-like group that is not noise stays.
        plain = pp.work_key(self.AUTHOR, "Tide Mill")
        for suffix in (" (Graphic Audio)", " [GraphicAudio]", " (BBC Radio 4)", " (Audible Original)", " (2)",
                       " [2]", " (Book 2)", " (Part 2)", " (Vol. 2)", " (No. 2)", " (Dolby Atmos)"):
            with self.subTest(suffix=suffix):
                self.assertNotEqual(pp.work_key(self.AUTHOR, "Tide Mill" + suffix), plain)
        self.assertNotEqual(pp.work_key(self.AUTHOR, "Tide Mill, Vol. 2"), pp.work_key(self.AUTHOR, "Tide Mill, Book 2"))
        self.assertNotEqual(pp.work_key(self.AUTHOR, "Tide Mill, Part 2"), pp.work_key(self.AUTHOR, "Tide Mill, Book 2"))
        self.assertNotEqual(pp.work_key(self.AUTHOR, "Tide Mill, No. 2"), pp.work_key(self.AUTHOR, "Tide Mill, Book 2"))

    def test_an_adversarial_corpus_never_merges_two_books(self):
        # Every spelling of a number in every place a book number can be, large
        # numbers and other scripts included: a key belongs to one book.
        words = {1: "One", 21: "Twenty-One", 30: "Thirty", 31: "Thirty-One", 40: "Forty", 41: "Forty-One",
                 50: "Fifty", 99: "Ninety-Nine", 100: "One Hundred", 101: "One Hundred and One"}
        roman = {1: "I", 21: "XXI", 30: "XXX", 31: "XXXI", 40: "XL", 41: "XLI", 50: "L", 99: "XCIX", 100: "C"}
        arabic = str.maketrans("0123456789", "\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669")
        wraps = ("Tide Mill, {p}", "Tide Mill ({p}, Unabridged)", "Tide Mill - Read by Tamsin Ashby, {p}",
                 "Tide Mill (Narrated by Tamsin Ashby, {p})", "Tide Mill - Read by Tamsin Ashby ({p})",
                 "Tide Mill - Read by Tamsin Ashby; {p}", "Tide Mill, {p} - Read by Tamsin Ashby",
                 "Tide Mill (Unabridged) [{p}] (2019)")
        owner = {}
        for wrap in wraps:
            for kind in ("Book", "Volume", "Part", "Series"):
                for n, word in words.items():
                    for spelling in {str(n), f"{n:03d}", word, str(n).translate(arabic), roman.get(n, word)}:
                        title = wrap.format(p=f"{kind} {spelling}")
                        key = pp.work_key(self.AUTHOR, title)
                        # Spellings of one number in a dropped part ("Series") can differ without
                        # merging anything: what must hold is that one key never holds two numbers.
                        self.assertEqual(owner.setdefault(key, (kind, n)), (kind, n), title)


    def test_nothing_is_taken_off_that_would_leave_the_title_empty(self):
        self.assertEqual(pp._work_title("Unabridged"), "unabridged")
        self.assertEqual(pp._work_title("(Full-Cast Edition)"), "full cast edition")
        self.assertEqual(pp._work_title(""), "")


class LiveLibraryKeys(unittest.TestCase):
    """The work keys of the dev instance's audiobook library as it stood on
    2026-10-03 (34 albums, each one book): spec 2.6 s3 changed the matcher,
    and this library's keying did not change at all. 21 works; every work
    that has several editions (a narrator each) is one key, and nothing else
    is. The key values are those the previous matcher gave, pinned."""

    LIBRARY = (
        ('George R.R. Martin', 'A Clash of Kings - Read by Roy Dotrice'),
        ('George R.R. Martin', 'A Dance with Dragons - Read by Roy Dotrice'),
        ('George R.R. Martin', 'A Feast for Crows - Read by Roy Dotrice'),
        ('George R.R. Martin', 'A Game of Thrones - Read by Roy Dotrice'),
        ('George R.R. Martin', 'A Storm of Swords - Read by Roy Dotrice'),
        ('J.K. Rowling', 'Harry Potter and the Chamber of Secrets - Read by Full Cast'),
        ('J.K. Rowling', 'Harry Potter and the Chamber of Secrets - Read by Jim Dale'),
        ('J.K. Rowling', 'Harry Potter and the Chamber of Secrets - Read by Stephen Fry'),
        ('J.K. Rowling', 'Harry Potter and the Deathly Hallows - Read by Full Cast'),
        ('J.K. Rowling', 'Harry Potter and the Deathly Hallows - Read by Jim Dale'),
        ('J.K. Rowling', 'Harry Potter and the Deathly Hallows - Read by Stephen Fry'),
        ('J.K. Rowling', 'Harry Potter and the Goblet of Fire - Read by Full Cast'),
        ('J.K. Rowling', 'Harry Potter and the Goblet of Fire - Read by Jim Dale'),
        ('J.K. Rowling', 'Harry Potter and the Goblet of Fire - Read by Stephen Fry'),
        ('J.K. Rowling', 'Harry Potter and the Half-Blood Prince - Read by Full Cast'),
        ('J.K. Rowling', 'Harry Potter and the Half-Blood Prince - Read by Jim Dale'),
        ('J.K. Rowling', 'Harry Potter and the Half-Blood Prince - Read by Stephen Fry'),
        ('J.K. Rowling', 'Harry Potter and the Order of the Phoenix - Read by Full Cast'),
        ('J.K. Rowling', 'Harry Potter and the Order of the Phoenix - Read by Jim Dale'),
        ('J.K. Rowling', 'Harry Potter and the Order of the Phoenix - Read by Stephen Fry'),
        ('J.K. Rowling', "Harry Potter and the Philosopher's Stone - Read by Stephen Fry"),
        ('J.K. Rowling', 'Harry Potter and the Prisoner of Azkaban - Read by Full Cast'),
        ('J.K. Rowling', 'Harry Potter and the Prisoner of Azkaban - Read by Jim Dale'),
        ('J.K. Rowling', 'Harry Potter and the Prisoner of Azkaban - Read by Stephen Fry'),
        ('J.K. Rowling', "Harry Potter and the Sorcerer's Stone - Read by Jim Dale"),
        ('J.K. Rowling', 'Harry Potter and the Sorcerer’s Stone - Read by Full Cast'),
        ('Joseph Heller', 'CATCH-22 - Read by Jay O. Sanders'),
        ('Matt Dinniman', "Carl's Doomsday Scenario - Read by Jeff Hays"),
        ('Matt Dinniman', "The Butcher's Masquerade - Read by Jeff Hays"),
        ('Matt Dinniman', "The Dungeon Anarchist's Cookbook - Read by Jeff Hays"),
        ('Matt Dinniman', 'The Eye of the Bedlam Bride - Read by Jeff Hays'),
        ('Matt Dinniman', 'The Gate of the Feral Gods - Read by Jeff Hays'),
        ('S.J.A. Turney', "Marius' Mules I: The Invasion of Gaul - Read by Malk Williams"),
        ('Sarah J. Maas', 'Queen of Shadows - Read by Elizabeth Evans'),
    )
    KEYS = {
        "003fe7dc4c79170c9c5f6a440799fbd8",
        "0071fd0871b013bcf3d14a49131374b6",
        "00f8a8d916a4e5bd31f358154b08394b",
        "172432dfb2d5b9deb6644735cbb406d7",
        "1a824449ebd1cdfad54ecfdd6b252709",
        "38aa37d8404ecef397390cfbe83672cb",
        "3b42b8771787605caee92e0815482cc1",
        "3b798d69b20026c6be2dab72471df857",
        "55a44c640e94765279a522dbb037ef92",
        "6d3f4645deead23f9f23ff1a103eae6e",
        "7fa75f288ea433762e018f2135a15345",
        "91109a5ea9f2879fe2cf997528b04044",
        "91157e7bac77cc4a3b260f5abc900db0",
        "9f9bda885ecaad407317273a3f89e1e3",
        "9ff24dbf7d90820d5512fb0af8a59b19",
        "a3b16fb047a587f727909a62c0af267c",
        "a9819cbbf55bc277238a4e08cc0ba6f4",
        "b2748765fc37ce6591bfff19e08601a8",
        "dbdca6f5943cec121d4f2ca4702d2f9c",
        "eef646e57db7a292fd0257ec9fbe28f2",
        "ff811a1f7107425cbdf7e49ce93d3f5a",
    }

    @staticmethod
    def key(author, title):
        shown, narrator = pp._split_narrator(title)
        return pp.work_key(author, title, narrator)

    def test_the_library_keys_as_before(self):
        keys = {self.key(a, t) for a, t in self.LIBRARY}
        self.assertEqual(len(self.LIBRARY), 34)
        self.assertEqual(keys, self.KEYS)

    def test_editions_of_one_work_share_a_key_and_no_two_works_do(self):
        groups = {}
        for author, title in self.LIBRARY:
            groups.setdefault(self.key(author, title), []).append(pp._work_words(pp._split_narrator(title)[0]))
        self.assertEqual(sorted(len(g) for g in groups.values()), [1] * 14 + [2] + [3] * 6)
        for key, titles in groups.items():
            with self.subTest(key=key):
                # Within a key every edition is one title (the Sorcerer's Stone
                # in two apostrophes aside), never two works.
                self.assertEqual(len(set(titles)), 1, titles)

    def test_the_library_as_one_disc_albums_keys_the_same_through_a_save(self):
        # book_identity and the album-level pre-check give the same key for an
        # album of one book.
        for author, title in self.LIBRARY:
            album = {"ratingKey": "500", "type": "album", "title": title, "titleSort": title,
                     "parentTitle": author}
            children = {"Metadata": [{"ratingKey": "501", "type": "track", "parentRatingKey": "500",
                                      "parentIndex": 1, "index": 1, "duration": 60_000, "title": "Part 1",
                                      "Media": [{"Part": [{"file": "/m/F/1.mp3", "duration": 60_000}]}]}]}
            with self.subTest(title=title):
                key = pp._identity(album, 1, children)["work_key"]
                self.assertEqual(key, self.key(author, title))
                self.assertEqual(key, pp.album_work_key(album))


def disc_key(author, album_title, disc_title, narrator=""):
    """The work key of a disc of an album holding several books (spec 2.6
    s3): the disc's own title under the album's own work title."""
    return pp._hash_work(author, pp._work_title(album_title, narrator) + pp._ALBUM_SEPARATOR
                         + pp._work_title(disc_title, narrator))


class BookIdentity(BridgeBase):
    def test_the_fields_a_save_records(self):
        out = self.run_async(pp.book_identity("200:1"))
        self.assertEqual(out, {"work_key": pp.work_key("Bea Writer", "Parts Book"), "author": "Bea Writer",
                               "narrator": "Pat Voice", "duration_ms": 600_000, "title": "Parts Book"})

    def test_it_matches_what_list_books_says_of_every_book(self):
        for book in self.run_async(pp.list_books()):
            with self.subTest(key=book["key"]):
                out = self.run_async(pp.book_identity(book["key"]))
                self.assertEqual(out["duration_ms"], book["duration_ms"])
                self.assertEqual(out["narrator"], book["narrator"] or None)
                album = ALBUMS[book["key"].split(":")[0]]
                if len({t["parentIndex"] for t in TRACKS[album["ratingKey"]]}) > 1:
                    expected = disc_key(book["author"], album["title"], book["title"], book["narrator"])
                else:
                    expected = pp.work_key(book["author"], book["title"], book["narrator"])
                self.assertEqual(out["work_key"], expected)

    def test_a_disc_of_a_series_album_is_its_own_work(self):
        first = self.run_async(pp.book_identity("400:1"))
        second = self.run_async(pp.book_identity("400:2"))
        self.assertEqual(second["duration_ms"], 70_000)
        self.assertEqual(second["work_key"], disc_key("Cal Penn", "Long Series - Read by Kim Moss", "Second Tale", "Kim Moss"))
        self.assertNotEqual(first["work_key"], second["work_key"])

    def test_a_disc_of_a_several_book_album_is_named_with_its_album_and_disc(self):
        # T1Z1: a box set's disc is often titled by its first track ("Chapter
        # One"), which names no copy; the kept title says which box and disc.
        self.assertEqual(self.run_async(pp.book_identity("400:1"))["title"], "Long Series, Disc 1: First Tale")
        self.assertEqual(self.run_async(pp.book_identity("400:2"))["title"], "Long Series, Disc 2: Second Tale")
        album = {"ratingKey": "650", "type": "album", "title": "Harbour Tales - Read by Kim Moss",
                 "titleSort": "Harbour Tales", "parentTitle": "Cal Penn", "thumb": "/library/metadata/650/thumb/1"}
        with mock.patch.dict(ALBUMS, {"650": album}), mock.patch.dict(TRACKS):
            TRACKS["650"] = [track(651, 650, 1, 1, 10_000, "E/Box1", title="Chapter One, Part 1"),
                             track(652, 650, 2, 1, 20_000, "E/Box2", title="Chapter One"),
                             track(653, 650, 3, 1, 30_000, "E/Box3", title=" ")]
            titles = [self.run_async(pp.book_identity(f"650:{d}"))["title"] for d in (1, 2, 3)]
        self.assertEqual(titles, ["Harbour Tales, Disc 1: Chapter One", "Harbour Tales, Disc 2: Chapter One",
                                  "Harbour Tales, Disc 3"])
        # An album of one book keeps the book's own title.
        self.assertEqual(self.run_async(pp.book_identity("200:1"))["title"], "Parts Book")
        self.assertEqual(pp._copy_title({"title": ""}, 2, [{"title": "Tale"}], 2, "Tale"), "Disc 2: Tale")

    def test_a_dash_narrator_in_the_album_title_is_taken_off_only_when_plex_names_them(self):
        named = dict(ALBUMS["500"], title="Quiet Book - Dee Lane", Collection=[{"tag": "Quiet Tales - Read by Dee Lane"}])
        with mock.patch.dict(ALBUMS, {"500": named}):
            out = self.run_async(pp.book_identity("500:1"))
        self.assertEqual(out["narrator"], "Dee Lane")
        self.assertEqual(out["work_key"], pp.work_key("Ann Author", "Quiet Book"))
        unnamed = dict(ALBUMS["500"], title="Quiet Book - Dee Lane")
        with mock.patch.dict(ALBUMS, {"500": unnamed}):
            out = self.run_async(pp.book_identity("500:1"))
        self.assertIsNone(out["narrator"])
        self.assertNotEqual(out["work_key"], pp.work_key("Ann Author", "Quiet Book"))

    def test_generic_disc_titles_of_a_several_book_album_stay_apart(self):
        # T1S6: discs whose first tracks say nothing ("Track 1", "Chapter 1",
        # "Opening Credits", "Part 1", "01") are named by the album and disc.
        for generic in ("Track 1", "Chapter 1", "Opening Credits", "Part 1", "01"):
            with self.subTest(generic=generic):
                album = {"ratingKey": "650", "type": "album", "title": "Harbour Tales", "titleSort": "Harbour Tales",
                         "parentTitle": "Cal Penn", "thumb": "/library/metadata/650/thumb/1"}
                with mock.patch.dict(ALBUMS, {"650": album}), mock.patch.dict(TRACKS):
                    TRACKS["650"] = [track(651, 650, 1, 1, 10_000, "E/Box1", title=generic),
                                     track(652, 650, 2, 1, 20_000, "E/Box2", title=generic),
                                     track(653, 650, 3, 1, 30_000, "E/Box3", title=generic)]
                    keys = [self.run_async(pp.book_identity(f"650:{d}"))["work_key"] for d in (1, 2, 3)]
                self.assertEqual(len(set(keys)), 3)
                self.assertEqual(keys[1], pp.work_key("Cal Penn", "Harbour Tales disc 2"))
        # A disc titled by its own track keeps that title, under the album's.
        self.assertEqual(self.run_async(pp.book_identity("400:2"))["work_key"],
                         disc_key("Cal Penn", "Long Series - Read by Kim Moss", "Second Tale", "Kim Moss"))

    def test_the_album_level_key_is_the_single_book_albums_key(self):
        # T1S5: an album of one book gives its key from the album alone.
        for rk in ("100", "200", "300", "500", "600", "700", "800"):
            with self.subTest(album=rk):
                self.assertEqual(pp.album_work_key(ALBUMS[rk]), self.run_async(pp.book_identity(f"{rk}:1"))["work_key"])
        self.assertIsNone(pp.album_work_key({"title": "Tide Mill"}))                 # no author
        self.assertIsNone(pp.album_work_key({"parentTitle": "", "title": ""}))

    # Every way of writing a book's number the reviewers tried: wherever it
    # falls (the title, the narrator's part, brackets), books 1, 2 and 3
    # never share a key.
    NUMBER_FORMATS = (
        "Tide Mill - Read by Tamsin Ashby, Book {n}", "Tide Mill (Narrated by Tamsin Ashby, Book {n})",
        "Tide Mill (Read by Tamsin Ashby, Book {n})", "Tide Mill - Read by Tamsin Ashby; Vol. {n}",
        "Tide Mill - Read by Tamsin Ashby, Part {n}", "Tide Mill - Read by Tamsin Ashby, #{n}",
        "Tide Mill - Read by Tamsin Ashby, Book {n}, Unabridged",
        "Tide Mill (Narrated by Tamsin Ashby, Book {n}, Unabridged)",
        "Tide Mill - Read by Tamsin Ashby, Book {n} (Unabridged)", "Tide Mill - Read by Tamsin Ashby (Book {n})",
        "Tide Mill - Read by Tamsin Ashby - Book {n}", "Tide Mill - Read by Tamsin Ashby \u2013 Volume {n}",
        "Tide Mill - Read by Tamsin Ashby [Book {n}]", "Tide Mill - Read by Tamsin Ashby {{No. {n}}}",
        "Tide Mill - Read by Tamsin Ashby #{n}", "Tide Mill - Read by Tamsin Ashby: Book {n}",
        "Tide Mill - Read by Tamsin Ashby, Book {n} of 5", "Tide Mill - Read by Tamsin Ashby, Book {n}.5",
        "Tide Mill - Read by Tamsin Ashby,Book #{n}", "Tide Mill - Read by Tamsin Ashby, Dee Lane, Book {n}",
        "Tide Mill - Read by Tamsin Ashby, Book {n}; Dee Lane", "Tide Mill (Narrated by Tamsin Ashby) Book {n}",
        "Tide Mill (Narrated by Tamsin Ashby, Book {r})", "Tide Mill - Read by BBC Radio 4 Full Cast, Volume {r}",
        "Tide Mill - Read by BBC Radio 4 Full Cast [Part {r}]", "Tide Mill, Book {n} - Read by Tamsin Ashby",
        "Tide Mill (Book {n}, Unabridged)", "Tide Mill: Book {n} (Unabridged)", "Tide Mill (Unabridged) (Book {n})",
        "Tide Mill Saga Book {n} - Read by BBC Radio 4 Full Cast")
    ROMAN = {1: "I", 2: "II", 3: "III"}

    def test_every_number_format_keeps_books_one_two_and_three_apart(self):
        # T1R8: the number is taken from the whole album title, not from
        # where the narrator split leaves it; through book_identity (a save)
        # and album_work_key (the pre-check) alike.
        owner = {}
        for fmt in self.NUMBER_FORMATS:
            keys = []
            for n in (1, 2, 3):
                album = dict(ALBUMS["500"], title=fmt.format(n=n, r=self.ROMAN[n]))
                album.pop("Collection", None)
                with self.subTest(title=album["title"]):
                    with mock.patch.dict(ALBUMS, {"500": album}):
                        out = self.run_async(pp.book_identity("500:1"))
                    self.assertEqual(out["work_key"], pp.album_work_key(album))
                    self.assertEqual(out["work_key"], pp.work_key("Ann Author", album["title"], out["narrator"] or ""))
                    keys.append(out["work_key"])
                    # A key never belongs to two different book numbers,
                    # whatever the format.
                    self.assertEqual(owner.setdefault(out["work_key"], n), n)
            self.assertEqual(len(set(keys)), 3, fmt)

    def test_the_list_view_names_books_as_before_the_number_moves(self):
        # The display is decoupled from the key: titles, narrators and series
        # are what they were at c06d33e, and the narrator is never emptied
        # ("BBC Radio 4 Full Cast" and "Read by X, Book 2" stay as written).
        cases = {
            "Tide Mill - Read by Tamsin Ashby, Book 2": ("Tide Mill", "Tamsin Ashby, Book 2"),
            "Tide Mill (Narrated by Tamsin Ashby, Book 2)": ("Tide Mill", "Tamsin Ashby, Book 2"),
            "Tide Mill - Read by Tamsin Ashby; Vol. 3": ("Tide Mill", "Tamsin Ashby; Vol. 3"),
            "Tide Mill - Read by Tamsin Ashby (Book 2)": ("Tide Mill", "Tamsin Ashby (Book 2)"),
            "Tide Mill - Read by Tamsin Ashby - Book 2": ("Tide Mill", "Tamsin Ashby - Book 2"),
            "Tide Mill - Read by Tamsin Ashby [Book 2]": ("Tide Mill", "Tamsin Ashby [Book 2]"),
            "Tide Mill - Read by Tamsin Ashby #2": ("Tide Mill", "Tamsin Ashby #2"),
            "Tide Mill - Read by Tamsin Ashby, Book 2, Unabridged": ("Tide Mill", "Tamsin Ashby, Book 2, Unabridged"),
            "Tide Mill (Narrated by Tamsin Ashby, Book II)": ("Tide Mill", "Tamsin Ashby, Book II"),
            "Tide Mill Saga Book 1 - Read by BBC Radio 4 Full Cast": ("Tide Mill Saga Book 1", "BBC Radio 4 Full Cast"),
            "Tide Mill - Read by 50 Voices": ("Tide Mill", "50 Voices"),
            "Tide Mill - Read by Part Time Players": ("Tide Mill", "Part Time Players"),
            "Tide Mill - Read by Book 2": ("Tide Mill", "Book 2"),
            "Tide Mill - Read by Tamsin Ashby, Dee Lane": ("Tide Mill", "Tamsin Ashby, Dee Lane"),
            "Tide Mill, Book 2 - Read by Tamsin Ashby": ("Tide Mill, Book 2", "Tamsin Ashby"),
            "Tide Mill (Book 2)": ("Tide Mill (Book 2)", "Tamsin Ashby, Book 9"),
        }
        for title, (shown, narrator) in cases.items():
            album = dict(ALBUMS["500"], title=title, Collection=[{"tag": "Tide Mill Saga - Read by Tamsin Ashby, Book 9"}])
            with self.subTest(title=title):
                with mock.patch.dict(ALBUMS, {"500": album}):
                    book = next(b for b in self.run_async(pp.list_books()) if b["key"] == "500:1")
                self.assertEqual((book["title"], book["narrator"], book["series"]),
                                 (shown, narrator, "Tide Mill Saga"))
        self.assertEqual(pp._split_narrator("Tide Mill Saga (Narrated by Tamsin Ashby; Vol. 1)"),
                         ("Tide Mill Saga", "Tamsin Ashby; Vol. 1"))

    def test_next_keeps_to_the_narrator_when_the_number_rides_in_the_narrator(self):
        # T1R8, as /next sees it: "Read by X, Book N, Unabridged" with a
        # second narrator's edition of book 2; book 1's narrator is kept.
        def book(key, title):
            album = {"ratingKey": key, "type": "album", "title": title, "titleSort": title,
                     "parentTitle": "Wren Hollis", "Collection": [{"tag": "Tide Mill Saga"}],
                     "thumb": f"/library/metadata/{key}/thumb/1"}
            tracks = [{"ratingKey": str(int(key) * 10), "type": "track", "parentRatingKey": key, "parentIndex": 1,
                       "index": 1, "duration": 60_000, "title": "Part 1",
                       "Media": [{"Part": [{"file": f"/m/{key}/1.mp3"}]}]}]
            return (album, 1, tracks, 1, pp._summary(album, 1, tracks, 1))
        for fmt in ("Tide Mill Saga - Read by {who}, Book {n}, Unabridged", "Tide Mill Saga - Read by {who} [Book {n}]",
                    "Tide Mill Saga - Read by {who} #{n}", "Tide Mill Saga - Read by {who}, Book {n} of 5"):
            with self.subTest(fmt=fmt):
                lib = [book("100", fmt.format(who="Tamsin Ashby", n=1)), book("200", fmt.format(who="Tamsin Ashby", n=2)),
                       book("250", fmt.format(who="Dee Lane", n=2)), book("300", fmt.format(who="Tamsin Ashby", n=3))]
                entries = pp._series_entries(lib)
                self.assertEqual(pp.pick_next(entries, "100:1")["key"], "200:1")
                self.assertEqual(pp.pick_next(entries, "250:1")["key"], "300:1")
                keys = [pp._identity(b[0], 1, {"Metadata": b[2]})["work_key"] for b in lib]
                self.assertEqual(len({keys[0], keys[1], keys[3]}), 3)
                self.assertEqual(keys[1], keys[2])      # two editions of book 2 side by side

    def test_next_keeps_to_a_narrator_whose_name_holds_a_digit(self):
        # T1R5, as /next sees it: book 1's narrator is kept, so the same
        # narrator's book 2 is offered, not the other edition.
        def book(key, title):
            album = {"ratingKey": key, "type": "album", "title": title, "titleSort": title,
                     "parentTitle": "Wren Hollis", "Collection": [{"tag": "Tide Mill Saga"}],
                     "thumb": f"/library/metadata/{key}/thumb/1"}
            tracks = [{"ratingKey": str(int(key) * 10), "type": "track", "parentRatingKey": key, "parentIndex": 1,
                       "index": 1, "duration": 60_000, "title": "Part 1",
                       "Media": [{"Part": [{"file": f"/m/{key}/1.mp3"}]}]}]
            return (album, 1, tracks, 1, pp._summary(album, 1, tracks, 1))
        lib = [book("100", "Tide Mill Saga Book 1 - Read by BBC Radio 4 Full Cast"),
               book("200", "Tide Mill Saga Book 2 - Read by BBC Radio 4 Full Cast"),
               book("300", "Tide Mill Saga Book 2")]
        self.assertEqual(lib[0][4]["narrator"], "BBC Radio 4 Full Cast")
        self.assertEqual(pp.pick_next(pp._series_entries(lib), "100:1")["key"], "200:1")

    def test_a_shared_disc_title_is_normalised_before_its_disc_number(self):
        # T1R6: two boxes whose shared disc titles differ only by what
        # normalising takes off give the same key per disc.
        def box(rk, title):
            album = {"ratingKey": rk, "type": "album", "title": "Harbour Tales", "titleSort": "Harbour Tales",
                     "parentTitle": "Cal Penn", "thumb": f"/library/metadata/{rk}/thumb/1"}
            with mock.patch.dict(ALBUMS, {rk: album}), mock.patch.dict(TRACKS):
                TRACKS[rk] = [track(int(rk) + 1, rk, 1, 1, 10_000, f"E/{rk}a", title=title),
                              track(int(rk) + 2, rk, 2, 1, 20_000, f"E/{rk}b", title=title)]
                return [self.run_async(pp.book_identity(f"{rk}:{d}"))["work_key"] for d in (1, 2)]
        plain = box("670", "Harbour Tales")
        self.assertNotEqual(plain[0], plain[1])
        for title in ("Harbour Tales (Unabridged)", "Harbour Tales - Read by Tamsin Ashby", "Harbour Tales [m4b]"):
            with self.subTest(title=title):
                self.assertEqual(box("680", title), plain)

    def test_discs_that_share_a_title_stay_apart(self):
        # T1R3: whatever the shared title, two discs of one album never share
        # a key; a disc with a title of its own keeps it.
        album = {"ratingKey": "660", "type": "album", "title": "Harbour Tales", "titleSort": "Harbour Tales",
                 "parentTitle": "Cal Penn", "thumb": "/library/metadata/660/thumb/1"}
        for shared in ("01 - Chapter 1", "Chapter One", "Part 1 of 12", "Disc 1 Track 1", "Credits", "Harbour Tales"):
            with self.subTest(shared=shared):
                with mock.patch.dict(ALBUMS, {"660": album}), mock.patch.dict(TRACKS):
                    TRACKS["660"] = [track(661, 660, 1, 1, 10_000, "E/T1", title=shared),
                                     track(662, 660, 2, 1, 20_000, "E/T2", title=shared),
                                     track(663, 660, 3, 1, 30_000, "E/T3", title="The Lighthouse")]
                    keys = [self.run_async(pp.book_identity(f"660:{d}"))["work_key"] for d in (1, 2, 3)]
                self.assertEqual(len(set(keys)), 3)
                self.assertEqual(keys[2], disc_key("Cal Penn", "Harbour Tales", "The Lighthouse"))

    def test_discs_of_different_albums_that_share_a_title_never_share_a_key(self):
        # 2.5 parked: two albums by one author whose discs share a title
        # ("Chapter One") had the same per-disc keys. The album's own work
        # title is part of every disc's key now (spec 2.6 s3); a box set
        # re-added under the same title (and what normalising takes off)
        # still gets its keys back.
        def box(rk, album_title, shared="Chapter One", author="Cal Penn"):
            album = {"ratingKey": rk, "type": "album", "title": album_title, "titleSort": album_title,
                     "parentTitle": author, "thumb": f"/library/metadata/{rk}/thumb/1"}
            with mock.patch.dict(ALBUMS, {rk: album}), mock.patch.dict(TRACKS):
                TRACKS[rk] = [track(int(rk) + 1, rk, 1, 1, 10_000, f"E/{rk}a", title=shared),
                              track(int(rk) + 2, rk, 2, 1, 20_000, f"E/{rk}b", title=shared),
                              track(int(rk) + 3, rk, 3, 1, 30_000, f"E/{rk}c", title="The Lighthouse")]
                return [self.run_async(pp.book_identity(f"{rk}:{d}"))["work_key"] for d in (1, 2, 3)]
        harbour = box("640", "Harbour Tales")
        island = box("645", "Island Tales")
        self.assertEqual(len(set(harbour + island)), 6)
        # Even a disc with a title of its own, and with no title in common.
        self.assertNotEqual(box("647", "Harbour Tales", shared="Opening")[2], island[2])
        self.assertEqual(box("650", "Harbour Tales (Unabridged)"), harbour)
        self.assertEqual(box("655", "Harbour Tales - Read by Kim Moss"), harbour)
        self.assertNotEqual(box("660", "Harbour Tales", author="Dee Lane"), harbour)

    def test_a_book_by_its_author_and_the_author_alone(self):
        self.assertEqual(self.run_async(pp.book_identity("100:1"))["author"], "Ann Author")
        self.assertEqual(pp.album_author(ALBUMS["200"]), "Bea Writer")
        self.assertEqual(pp.album_author({"title": "Tide Mill"}), "")
        album = dict(ALBUMS["500"], parentTitle=" ")
        with mock.patch.dict(ALBUMS, {"500": album}):
            self.assertIsNone(self.run_async(pp.book_identity("500:1"))["author"])
        # Case, spacing and punctuation are not a different author.
        self.assertTrue(pp.same_author("J.K. Rowling", "J. K. Rowling"))
        self.assertTrue(pp.same_author("ren\u00e9e ash", "Renee  Ash"))
        self.assertFalse(pp.same_author("J.K. Rowling", "Matt Dinniman"))
        self.assertFalse(pp.same_author("", ""))
        self.assertFalse(pp.same_author(None, "Ann Author"))

    def test_untitled_discs_are_keyed_from_the_albums_whole_title(self):
        # T1K4: a disc whose first track has no title is named by the album
        # as Plex gives it, so a book number in its narration still counts.
        def keys(rk, title):
            album = {"ratingKey": rk, "type": "album", "title": title, "titleSort": title,
                     "parentTitle": "Cal Penn", "thumb": f"/library/metadata/{rk}/thumb/1"}
            with mock.patch.dict(ALBUMS, {rk: album}), mock.patch.dict(TRACKS):
                TRACKS[rk] = [dict(track(int(rk) + 1, rk, 1, 1, 10_000, f"E/{rk}a"), title=""),
                              dict(track(int(rk) + 2, rk, 2, 1, 20_000, f"E/{rk}b"), title="")]
                return [self.run_async(pp.book_identity(f"{rk}:{d}"))["work_key"] for d in (1, 2)]
        two, three = keys("690", "Harbour Tales - Read by Tamsin Ashby, Book 2"), \
            keys("695", "Harbour Tales - Read by Tamsin Ashby, Book 3")
        self.assertEqual(len(set(two + three)), 4)
        self.assertEqual(two, keys("697", "Harbour Tales, Book 2 (Unabridged)"))

    def test_a_duplicate_copy_is_not_counted_in_the_length(self):
        self.assertEqual(self.run_async(pp.book_identity("300:1"))["duration_ms"], 510_000)

    def test_the_checkins_album_read_is_reused(self):
        # The check-in path: the album and track reads that check the book,
        # then only the album's tracks.
        album = self.run_async(pp.assert_in_library("200:1", track_key="202"))
        self.run_async(pp.book_identity("200:1", album=album))
        self.assertEqual(self.plex.paths(), ["/library/metadata/200", "/library/metadata/202",
                                             "/library/metadata/200/children"])

    def test_no_durations_and_no_narrator_are_none(self):
        silent = [dict(t, duration=0, Media=[{"Part": [{"file": "/data/Audiobooks/A/Quiet/501.mp3"}]}])
                  for t in TRACKS["500"]]
        with mock.patch.dict(TRACKS, {"500": silent}):
            out = self.run_async(pp.book_identity("500:1"))
        self.assertEqual((out["duration_ms"], out["narrator"]), (None, None))
        self.assertEqual(out["work_key"], pp.work_key("Ann Author", "Quiet Book"))

    def test_unknown_books_and_outages(self):
        for key in ("999:1", "900:1", "200:7", "junk"):
            with self.subTest(key=key):
                with self.assertRaises(pp.NotInLibrary):
                    self.run_async(pp.book_identity(key))
        self.plex.pms_down = 503
        with self.assertRaises(pp.PlayerUnavailable):
            self.run_async(pp.book_identity("200:1"))


class DiscInLibrary(BridgeBase):
    """pp.disc_in_library: an album can stay while a disc of it goes."""

    def test_a_disc_of_the_album_is_there_or_not(self):
        self.assertTrue(self.run_async(pp.disc_in_library("400:1")))
        self.assertTrue(self.run_async(pp.disc_in_library("400:2")))
        self.assertFalse(self.run_async(pp.disc_in_library("400:3")))
        self.assertFalse(self.run_async(pp.disc_in_library("400:999999")))
        self.assertTrue(self.run_async(pp.disc_in_library("200:1")))
        self.assertFalse(self.run_async(pp.disc_in_library("200:2")))

    def test_an_album_that_is_not_there_and_malformed_keys(self):
        self.assertFalse(self.run_async(pp.disc_in_library("999:1")))
        with self.assertRaises(pp.NotInLibrary):
            self.run_async(pp.disc_in_library("junk"))

    def test_plex_failing_is_unavailable(self):
        self.plex.pms_down = 503
        with self.assertRaises(pp.PlayerUnavailable):
            self.run_async(pp.disc_in_library("400:1"))


class CheckinBook(BridgeBase):
    """The check-in's reads: the album, the track and the album's tracks,
    made at once."""

    def concurrent(self):
        """Wrap the fake Plex so each request waits a moment; returns the
        most requests seen in flight at once."""
        state = {"now": 0, "most": 0}
        plex = self.plex

        async def handle(request):
            state["now"] += 1
            state["most"] = max(state["most"], state["now"])
            await asyncio.sleep(0.02)
            state["now"] -= 1
            return plex.handle(request)

        def factory(*args, **kwargs):
            kwargs.pop("verify", None)
            return RealAsyncClient(*args, transport=httpx.MockTransport(handle), **kwargs)
        p = mock.patch.object(pp.httpx, "AsyncClient", factory)
        p.start()
        self.addCleanup(p.stop)
        return state

    def test_the_three_reads_are_made_at_once(self):
        state = self.concurrent()
        album, about = self.run_async(pp.checkin_book("200:1", "202"))
        self.assertEqual(album["ratingKey"], "200")
        self.assertEqual(about, self.run_async(pp.book_identity("200:1")))
        self.assertEqual(state["most"], 3)
        self.assertEqual(sorted(self.plex.paths()[:3]), ["/library/metadata/200", "/library/metadata/200/children",
                                                          "/library/metadata/202"])

    def test_book_identity_reads_the_album_and_tracks_at_once(self):
        state = self.concurrent()
        self.run_async(pp.book_identity("200:1"))
        self.assertEqual(state["most"], 2)

    def test_it_checks_the_book_and_track_as_assert_in_library_does(self):
        for key, track_key in (("200:1", "101"), ("200:1", "901"), ("200:1", "411"), ("200:1", "999"),
                               ("400:2", "401"), ("999:1", "202"), ("900:1", "901")):
            with self.subTest(key=key, track=track_key):
                with self.assertRaises(pp.NotInLibrary):
                    self.run_async(pp.checkin_book(key, track_key))
        self.plex.calls.clear()
        for key, track_key in (("junk", "202"), ("200:1", "abc"), ("200:1", None)):
            with self.subTest(key=key, track=track_key):
                with self.assertRaises(pp.NotInLibrary):
                    self.run_async(pp.checkin_book(key, track_key))
        self.assertEqual(self.plex.calls, [])
        self.plex.pms_down = 503
        with self.assertRaises(pp.PlayerUnavailable):
            self.run_async(pp.checkin_book("200:1", "202"))

    def test_a_failed_tracks_read_still_checks_in_without_identity(self):
        for body in ({"MediaContainer": {"Metadata": "odd"}}, None):
            with self.subTest(body=body):
                orig = self.plex.handle

                def handle(request, orig=orig, body=body):
                    if request.url.path == "/library/metadata/200/children":
                        self.plex.calls.append(request)
                        return httpx.Response(503) if body is None else httpx.Response(200, json=body)
                    return orig(request)
                self.plex.handle = handle
                try:
                    album, about = self.run_async(pp.checkin_book("200:1", "202"))
                finally:
                    self.plex.handle = orig
                self.assertEqual(album["ratingKey"], "200")
                self.assertIsNone(about)


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

    def test_plex_position_strict_tells_an_unreadable_state_from_no_place(self):
        # strict=True (GET /position, for its plex_error): a 404 or an odd
        # shape on the listener's state read raises PlexStateUnreadable;
        # without it (any other caller) both stay "no place", as before.
        orig = self.plex.handle
        for label, reply in (("404", httpx.Response(404)),
                             ("odd shape", httpx.Response(200, json={"MediaContainer": {"Metadata": {"k": 1}}})),
                             ("strings", httpx.Response(200, json={"MediaContainer": {"Metadata": ["x"]}}))):
            with self.subTest(read=label):
                def handle(request, orig=orig, reply=reply):
                    if request.url.path == "/library/metadata/200/children" and \
                            request.headers.get("X-Plex-Token") == SERVER_TOKEN:
                        self.plex.calls.append(request)
                        return reply
                    return orig(request)
                self.plex.handle = handle
                try:
                    with self.assertRaises(pp.PlexStateUnreadable):
                        self.run_async(pp.plex_position(listener(), "200:1", session_id=SID, strict=True))
                    self.assertIsNone(self.run_async(pp.plex_position(listener(), "200:1", session_id=SID)))
                finally:
                    self.plex.handle = orig
        self.assertTrue(issubclass(pp.PlexStateUnreadable, pp.PlayerUnavailable))
        # A readable answer with no place is no place, strict or not.
        self.assertIsNone(self.run_async(pp.plex_position(listener(), "200:1", session_id=SID, strict=True)))

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
