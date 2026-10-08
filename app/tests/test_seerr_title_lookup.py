"""
TMDB numbers films and shows separately, so one batch of Seerr title
lookups can hold a film and a show with the same tmdb id. Keyed by the id
alone, the later answer named both: the event log's "Requested:" line and
"where requests stand" gave the film the show's title, or the other way
round. seerr.lookup_titles now answers by (media type, tmdb id), and both of
its callers read it that way.
"""
import asyncio
import unittest
from datetime import datetime
from unittest import mock

from app.tests import helpers

try:
    from app.integrations import seerr
    from app.services import notification_poller as poller
    from app.services import request_status, status_feed
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

T0 = datetime(2026, 10, 7, 12, 0, 0)
CONFIG = {"url": "http://seerr.invalid", "api_key": "k"}


class _Resp:
    status_code = 200

    def __init__(self, data):
        self._data = data

    def json(self):
        return self._data


class _Seerr:
    """Stub Seerr: /movie/1399 and /tv/1399 are different titles, and the
    show answers last, as the one that used to win. Anything else fails the
    test rather than reaching anything real."""

    def __init__(self, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, **kwargs):
        if url == "http://seerr.invalid/api/v1/movie/1399":
            await asyncio.sleep(0.01)
            return _Resp({"title": "Some Film", "releaseDate": "2019-05-01"})
        if url == "http://seerr.invalid/api/v1/tv/1399":
            await asyncio.sleep(0.05)
            return _Resp({"name": "Game of Thrones", "firstAirDate": "2011-04-17"})
        raise AssertionError(f"unscripted GET {url}")


def _stub_seerr():
    return (mock.patch.object(seerr, "_get_config", return_value=dict(CONFIG)),
            mock.patch.object(seerr.httpx, "AsyncClient", _Seerr))


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class LookupTitles(unittest.TestCase):
    def setUp(self):
        for p in _stub_seerr():
            p.start()
            self.addCleanup(p.stop)

    def test_a_film_and_a_show_with_one_tmdb_id_keep_their_own_titles(self):
        found = asyncio.run(seerr.lookup_titles([{"tmdb_id": 1399, "media_type": "movie"},
                                                 {"tmdb_id": 1399, "media_type": "tv"}]))
        self.assertEqual(found, {("movie", 1399): {"title": "Some Film", "year": 2019},
                                 ("tv", 1399): {"title": "Game of Thrones", "year": 2011}})


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class EventLogRequests(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        for p in (*_stub_seerr(), mock.patch.object(poller, "SessionLocal", self.Session),
                  mock.patch.object(status_feed, "now_utc", lambda: T0)):
            p.start()
            self.addCleanup(p.stop)

    def test_each_request_line_names_its_own_title(self):
        asyncio.run(poller.record_new_requests([]))
        asyncio.run(poller.record_new_requests([
            {"id": 1, "type": "movie", "status": 2, "media": {"tmdbId": 1399}},
            {"id": 2, "type": "tv", "status": 2, "media": {"tmdbId": 1399}}]))
        db = self.Session()
        try:
            lines = [i["text"] for i in status_feed.feed(db, 30, T0)["items"]]
        finally:
            db.close()
        self.assertEqual(sorted(lines), ["Requested: Game of Thrones", "Requested: Some Film (2019)"])


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class WhereRequestsStand(unittest.TestCase):
    def test_each_unnamed_row_gets_its_own_title(self):
        # Never added to Radarr or Sonarr, so only Seerr can name them.
        requests = [{"request_id": 1, "media_type": "movie", "tmdb_id": 1399, "request_status": 2,
                     "media_status": 2, "requested_at": "2026-01-01T00:00:00Z"},
                    {"request_id": 2, "media_type": "tv", "tmdb_id": 1399, "request_status": 2,
                     "media_status": 2, "requested_at": "2026-01-02T00:00:00Z"}]
        from app.integrations import plex, radarr, sonarr
        patches = (*_stub_seerr(),
                   mock.patch.object(seerr, "get_all_requests", mock.AsyncMock(return_value=requests)),
                   mock.patch.object(radarr, "get_movies_by_tmdb", mock.AsyncMock(return_value={})),
                   mock.patch.object(radarr, "get_queue_by_movie_id", mock.AsyncMock(return_value={})),
                   mock.patch.object(sonarr, "get_series_by_tvdb", mock.AsyncMock(return_value={})),
                   mock.patch.object(sonarr, "get_queue_by_series_id", mock.AsyncMock(return_value={})),
                   mock.patch.object(plex, "tmdb_ids_present", mock.AsyncMock(return_value=set())))
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        snapshot = asyncio.run(request_status.build_snapshot())
        titles = {(r["media_type"], r["title"]) for r in snapshot["items"]}
        self.assertEqual(titles, {("movie", "Some Film"), ("tv", "Game of Thrones")})


if __name__ == "__main__":
    unittest.main()
