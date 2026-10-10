"""
The Plex reads Insights needs (docs/superpowers/specs/2026-10-10-insights-design.md,
section 4.2): every play with its time and track, every track's length, and
the names plex.tv gives the people the server is shared with. Against fakes
on an httpx.MockTransport: any call the fake doesn't expect fails the test.
"""
import asyncio
import unittest
from datetime import datetime, timezone
from unittest import mock

try:
    import httpx
    from app.integrations import plex_player as pp
    from app.integrations import plex_share
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

ADMIN = {"url": "http://plex.test", "token": "ADMIN-SENTINEL", "section": "12"}
SINCE = datetime(2026, 10, 1)
FLOOR = int(SINCE.replace(tzinfo=timezone.utc).timestamp())


def pms(handler):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://plex.test")
    return mock.patch.object(pp, "_pms_client", return_value=client), mock.patch.object(pp, "_admin", return_value=ADMIN)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class PlayEvents(unittest.TestCase):
    def test_each_track_play_with_its_time_track_and_account(self):
        def answer(request):
            self.assertEqual(request.url.path, "/status/sessions/history/all")
            self.assertEqual(request.headers.get("x-plex-token"), "ADMIN-SENTINEL")
            return httpx.Response(200, json={"MediaContainer": {"Metadata": [
                # Plex's real shape: the album only as parentKey.
                {"type": "track", "accountID": 1, "parentKey": "/library/metadata/100", "parentIndex": 2,
                 "ratingKey": "1001", "viewedAt": FLOOR + 3600},
                # Both: parentRatingKey wins.
                {"type": "track", "accountID": 4242, "parentRatingKey": "200", "parentKey": "/library/metadata/9",
                 "ratingKey": "2001", "viewedAt": FLOOR + 60},
                {"type": "episode", "accountID": 3, "parentKey": "/library/metadata/7", "ratingKey": "70",
                 "viewedAt": FLOOR + 50},
                {"type": "track", "accountID": "", "parentKey": "/library/metadata/300", "ratingKey": "3001",
                 "viewedAt": FLOOR + 40},
                # Skipped and counted: neither album key, no track key, a parentKey that is not
                # /library/metadata/<digits>, a track key that is not a rating key.
                {"type": "track", "accountID": 6, "ratingKey": "6001", "viewedAt": FLOOR + 30},
                {"type": "track", "accountID": 6, "parentKey": "/library/metadata/600", "viewedAt": FLOOR + 30},
                {"type": "track", "accountID": 6, "parentKey": "/library/metadata/600/children", "ratingKey": "6002",
                 "viewedAt": FLOOR + 30},
                {"type": "track", "accountID": 6, "parentKey": "/library/metadata/600", "ratingKey": "x",
                 "viewedAt": FLOOR + 30},
                {"type": "track", "accountID": 5, "parentKey": "/library/metadata/400", "ratingKey": "4001",
                 "viewedAt": FLOOR - 1}]}})
        client, admin = pms(answer)
        with client, admin, self.assertLogs(pp.logger, level="DEBUG") as logs:
            events = asyncio.run(pp.play_events(SINCE))
        self.assertEqual(events, [
            {"account": "1", "book_key": "100:2", "track_key": "1001", "viewed_at": datetime(2026, 10, 1, 1, 0)},
            {"account": "4242", "book_key": "200:1", "track_key": "2001", "viewed_at": datetime(2026, 10, 1, 0, 1)}])
        self.assertEqual(logs.output, [f"DEBUG:{pp.logger.name}:Plex history: skipped 4 track plays with no album or "
                                       "track key"])

    def test_play_history_is_the_same_plays_as_pairs(self):
        events = [{"account": "1", "book_key": "100:2", "track_key": "1", "viewed_at": SINCE}]
        with mock.patch.object(pp, "play_events", mock.AsyncMock(return_value=events)):
            self.assertEqual(asyncio.run(pp.play_history(SINCE)), [("1", "100:2")])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TrackDurations(unittest.TestCase):
    def test_one_read_of_every_track(self):
        calls = []

        def answer(request):
            calls.append((request.url.path, request.url.params.get("type")))
            return httpx.Response(200, json={"MediaContainer": {"Metadata": [
                {"ratingKey": "1001", "duration": 600000},
                {"ratingKey": "1002", "Media": [{"Part": [{"duration": 300000}]}]},
                {"ratingKey": "bad", "duration": 5}]}})
        client, admin = pms(answer)
        with client, admin:
            found = asyncio.run(pp.track_durations())
        self.assertEqual(found, {"1001": 600000, "1002": 300000})
        self.assertEqual(calls, [("/library/sections/12/all", "10")])

    def test_a_missing_library_is_unavailable(self):
        client, admin = pms(lambda request: httpx.Response(404))
        with client, admin, self.assertRaises(pp.PlayerUnavailable):
            asyncio.run(pp.track_durations())


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ServerPeople(unittest.TestCase):
    def use(self, status=200):
        calls = []

        def handler(request):
            url = str(request.url)
            calls.append((url, request.headers.get("x-plex-token")))
            if url == "https://clients.plex.tv/api/v2/shared_servers/owned/accepted":
                return httpx.Response(status, json=[
                    {"invitedId": 5, "invited": {"id": 5, "title": "Sam", "username": "sam", "email": "s@x.test"}},
                    {"invitedId": 6, "invited": {"id": 6, "username": "kim"}},
                    {"invitedId": 7, "invited": "junk"}, "junk"])
            if url == "https://plex.tv/api/v2/user":
                return httpx.Response(200, json={"id": 99, "title": "Owner", "email": "o@x.test",
                                                 "authToken": "OWNER-SENTINEL"})
            raise AssertionError(f"unexpected Plex call: {url}")
        server = plex_share.PlexServer("m1", {"Accept": "application/json", "X-Plex-Token": "ADMIN-SENTINEL"})
        for p in (mock.patch.object(plex_share, "_server", mock.AsyncMock(return_value=server)),
                  mock.patch.object(plex_share, "_client", lambda: httpx.AsyncClient(
                      transport=httpx.MockTransport(handler), timeout=plex_share.TIMEOUT))):
            p.start()
            self.addCleanup(p.stop)
        return calls

    def test_names_for_each_share_and_the_owner(self):
        calls = self.use()
        found = asyncio.run(plex_share.server_people())
        self.assertEqual(found, {"owner": "99", "names": {"5": "Sam", "6": "kim", "99": "Owner"}})
        self.assertNotIn("x.test", repr(found))
        self.assertNotIn("OWNER-SENTINEL", repr(found))
        for url, token in calls:
            self.assertEqual(token, "ADMIN-SENTINEL")
            self.assertNotIn("ADMIN-SENTINEL", url)

    def test_a_refusal_is_unavailable(self):
        self.use(status=500)
        with self.assertRaises(plex_share.PlexShareUnavailable):
            asyncio.run(plex_share.server_people())


if __name__ == "__main__":
    unittest.main()
