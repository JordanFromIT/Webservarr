"""
Right now, live (docs/superpowers/specs/2026-10-10-insights-design.md,
sections 4.5 and 7): Plex apps playing in the audiobook library (not the web
player's own session, which is already counted), and WebServarr's reader,
noted at the Kavita proxy for five minutes. Fakes only: no Plex, no Redis.
"""
import asyncio
import inspect
import json
import unittest
from datetime import datetime, timedelta
from unittest import mock

try:
    import httpx
    from app.tests.test_insights_api import ME, NOW, Base
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False
    Base = unittest.TestCase
if HAVE_APP:
    from app.integrations import plex
    from app.models import Book
    from app.services import insights
    from app.utils import identity_key

SESSIONS_XML = """<MediaContainer size="4">
  <Track ratingKey="1001" parentRatingKey="100" parentIndex="1" librarySectionID="12" title="Chapter 1"
         parentTitle="Dune" grandparentTitle="Frank Herbert" viewOffset="60000" duration="600000">
    <User id="1" title="Owner"/><Player product="Plexamp" state="playing"/>
  </Track>
  <Track ratingKey="2001" parentRatingKey="200" parentIndex="2" librarySectionID="12" title="Part 2"
         parentTitle="Emma" grandparentTitle="Jane Austen" viewOffset="5" duration="9">
    <User id="4242" title="Sam"/><Player product="WebServarr" state="paused"/>
  </Track>
  <Track ratingKey="3001" parentRatingKey="300" librarySectionID="3" title="A song"><User id="5"/><Player product="Plexamp"/></Track>
  <Video ratingKey="9" librarySectionID="1" title="A film"><User id="5"/></Video>
</MediaContainer>"""


class FakeRedis:
    """get, set with ex, and scan_iter: what the reading note needs."""

    def __init__(self):
        self.data = {}
        self.ttl = {}

    async def get(self, key):
        return self.data.get(key)

    async def set(self, key, value, ex=None):
        self.data[key] = value.encode() if isinstance(value, str) else value
        self.ttl[key] = ex
        return True

    async def scan_iter(self, match=None, count=None):
        prefix = (match or "*").rstrip("*")
        for key in list(self.data):
            if key.startswith(prefix):
                yield key.encode()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Sessions(unittest.TestCase):
    def test_tracks_in_the_audiobook_section_only(self):
        real = httpx.AsyncClient

        def answer(request):
            self.assertEqual((request.url.path, request.headers.get("x-plex-token")), ("/status/sessions", "ADMIN"))
            return httpx.Response(200, text=SESSIONS_XML)
        with mock.patch.object(plex, "_get_config", return_value={"url": "http://plex.test", "token": "ADMIN"}), \
                mock.patch.object(plex.httpx, "AsyncClient",
                                  lambda **kw: real(transport=httpx.MockTransport(answer))):
            found = asyncio.run(plex.audiobook_sessions("12"))
        self.assertEqual(found, [
            {"account": "1", "book_key": "100:1", "title": "Chapter 1", "album": "Dune", "author": "Frank Herbert",
             "offset_ms": 60000, "duration_ms": 600000, "state": "playing", "product": "Plexamp"},
            {"account": "4242", "book_key": "200:2", "title": "Part 2", "album": "Emma", "author": "Jane Austen",
             "offset_ms": 5, "duration_ms": 9, "state": "paused", "product": "WebServarr"}])

    def test_plex_down_is_unavailable(self):
        real = httpx.AsyncClient
        for answer in (lambda r: httpx.Response(500), lambda r: httpx.Response(200, text="<not xml")):
            with self.subTest(answer=answer), \
                    mock.patch.object(plex, "_get_config", return_value={"url": "http://plex.test", "token": "A"}), \
                    mock.patch.object(plex.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(answer))), \
                    self.assertRaises(plex.PlexSessionsUnavailable):
                asyncio.run(plex.audiobook_sessions("12"))


class NowLive(Base):
    def test_plex_apps_and_the_reader_join_the_web_player(self):
        self.book(1, "Dune", keys=["100:1"])
        self.add(Book(id=2, title="Ulysses", sort_title="Ulysses", author="James Joyce", series="", description="",
                      kavita_chapter_id=31, kavita_volume_id=30, kavita_series_id=9, cover_source="kavita",
                      updated_at=NOW))
        sessions = [{"account": "1", "book_key": "100:1", "title": "Chapter 1", "album": "Dune", "author": "",
                     "offset_ms": 0, "duration_ms": 1, "state": "playing", "product": "Plexamp"},
                    {"account": "4242", "book_key": "200:2", "title": "Part 2", "album": "Emma", "author": "",
                     "offset_ms": 0, "duration_ms": 1, "state": "paused", "product": "WebServarr"}]
        reading = [{"identity": "plex:2002", "volume_id": 30, "chapter_id": 77, "page": 40,
                    "at": "2026-10-10T12:29:00.000Z"}]
        got = insights.now_view(self.db, {"1001": "Sam"}, NOW, sessions=sessions, reading=reading, owner="1001")
        self.assertEqual([(i["name"], i["title"], i["where"], i["state"], i["device"]) for i in got["listening"]],
                         [("Sam", "Dune", "plex", "playing", "Plexamp")])
        self.assertEqual([(i["name"], i["title"], i["page"]) for i in got["reading"]], [("Account 2002", "Ulysses", 40)])
        self.assertEqual(got["unavailable"], [])
        self.assertEqual(insights.now_view(self.db, {}, NOW, sessions=None)["unavailable"], ["plex"])

    def test_sessions_are_kept_15_s_and_plex_down_is_none(self):
        from app.integrations import plex_player as pp
        on = {"url": "http://plex.test", "token": "A", "section": "12"}
        r = FakeRedis()
        down = mock.AsyncMock(side_effect=plex.PlexSessionsUnavailable("Plex didn't answer"))
        with mock.patch.object(pp, "_admin", return_value=on), mock.patch.object(plex, "audiobook_sessions", down):
            self.assertIsNone(asyncio.run(insights.plex_sessions(r)))
        self.assertEqual(r.data, {})
        found = [{"account": "1", "book_key": "100:1", "title": "Chapter 1", "album": "Dune", "author": "",
                  "offset_ms": 0, "duration_ms": 1, "state": "playing", "product": "Plexamp"}]
        read = mock.AsyncMock(return_value=found)
        with mock.patch.object(pp, "_admin", return_value=on), mock.patch.object(plex, "audiobook_sessions", read):
            self.assertEqual(asyncio.run(insights.plex_sessions(r)), found)
            self.assertEqual(asyncio.run(insights.plex_sessions(r)), found)
        read.assert_awaited_once_with("12")
        self.assertEqual(list(r.ttl.values()), [15])
        with mock.patch.object(pp, "_admin", return_value=dict(on, section="")), \
                mock.patch.object(plex, "audiobook_sessions", read):
            self.assertEqual(asyncio.run(insights.plex_sessions(FakeRedis())), [])
        self.assertEqual(read.await_count, 1)

    def test_a_reader_save_is_noted_for_five_minutes_and_only_its_numbers(self):
        r = FakeRedis()
        body = json.dumps({"libraryId": 1, "seriesId": 9, "volumeId": 30, "chapterId": 77, "pageNum": 40,
                           "note": "x" * 50}).encode()
        asyncio.run(insights.note_reading(r, ME, body, now=NOW))
        asyncio.run(insights.note_reading(r, ME, b"not json", now=NOW))
        asyncio.run(insights.note_reading(r, "", body, now=NOW))
        self.assertEqual(list(r.data), [insights.READING_PREFIX + identity_key(ME)])
        self.assertEqual(list(r.ttl.values()), [300])
        self.assertEqual(asyncio.run(insights.reading_now(r)),
                         [{"identity": ME, "volume_id": 30, "chapter_id": 77, "page": 40, "at": "2026-10-10T12:30:00.000Z"}])

    def test_the_proxy_notes_a_progress_save_kavita_took(self):
        from app.routers import kavita_proxy
        src = inspect.getsource(kavita_proxy.kavita_proxy)
        self.assertIn('request.method == "POST" and path.lower() == "api/reader/progress"', src)
        self.assertIn("200 <= upstream.status_code < 300", src)
        self.assertIn("await _note_reading(current_user, body)", src)
        seen = mock.AsyncMock()
        with mock.patch.object(insights, "note_reading", seen), \
                mock.patch.object(kavita_proxy.session_manager, "get_redis", mock.AsyncMock(return_value=FakeRedis())):
            asyncio.run(kavita_proxy._note_reading({"auth_method": "plex", "plex_account_id": "1001"}, b"{}"))
        self.assertEqual(seen.await_args.args[1:], (ME, b"{}"))


if __name__ == "__main__":
    unittest.main()
