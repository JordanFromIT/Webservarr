"""
More event log sources (spec
docs/superpowers/specs/2026-10-05-event-log-library-events-design.md,
section 11): new requests from Seerr's request list and WebServarr's own
book requests (seeded, once each, folded in bursts), issues n8n says were
fixed (POST /api/webhooks/n8n: auth, the sentences, screening, repeats and
the cap) and Kometa runs (POST /api/webhooks/kometa/<token>: run_end per
library type, every other event ignored, the 6-hour cap, the token kept out
of the access log). They are library lines: never pinned, never a person.
"""
import asyncio
import logging
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest import mock

from app.services import activity_lines
from app.tests import helpers

try:
    import fastapi  # noqa: F401 - only present with the app's dependencies
    import sqlalchemy  # noqa: F401
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

if HAVE_APP:
    from sqlalchemy.orm import sessionmaker

    from app.models import Setting, StatusEventRef, StatusUpdate
    from app.services import notification_poller as poller
    from app.services import status_feed
    from app.tests.test_notification_poller import FakeRedis

T0 = datetime(2026, 10, 7, 12, 0, 0)
N8N_SECRET = "n8n-test-secret"
KOMETA_TOKEN = "kometaTestToken0123456789abcdefgh"

# Words in real payloads that must never reach a line.
PRIVATE = ("requester-jane", "jane@example.com", "Plex Jane", "Halloween Spooky Picks", "My Movies 4K",
           "/data/media")


def run(coro):
    return asyncio.run(coro)


class RequestWords(unittest.TestCase):
    def test_films_shows_and_books(self):
        self.assertEqual(activity_lines.request_line("Dune Messiah", 2026), "Requested: Dune Messiah (2026)")
        self.assertEqual(activity_lines.request_line("Severance"), "Requested: Severance")
        self.assertEqual(activity_lines.request_line("Dune Messiah", fmt="audiobook"),
                         "Requested: Dune Messiah (audiobook)")
        self.assertEqual(activity_lines.request_line("Dune Messiah", fmt="ebook"), "Requested: Dune Messiah (ebook)")
        self.assertEqual(activity_lines.request_line("  Dune\n Messiah ", True), "Requested: Dune Messiah")
        self.assertIsNone(activity_lines.request_line(""))
        self.assertIsNone(activity_lines.request_line(None, 2026))
        self.assertEqual(activity_lines.burst_line(5), "Requested: 5 titles")

    def test_lines_stay_under_200_characters_and_keep_the_year(self):
        line = activity_lines.request_line("A" * 400, 2026)
        self.assertLess(len(line), 200)
        self.assertTrue(line.endswith("… (2026)"))


class FixedWords(unittest.TestCase):
    def body(self, **fields):
        body = {"kind": "issue_fixed", "title": "Severance", "code": "S02E03", "year": None,
                "problem": "subtitles", "ref": "123"}
        body.update(fields)
        return body

    def test_one_sentence_per_problem(self):
        cases = [
            ({}, "Fixed: Severance S02E03 (subtitles)"),
            ({"problem": "audio"}, "Fixed: Severance S02E03 (audio)"),
            ({"problem": "video", "title": "Dune", "code": None, "year": 2021}, "Fixed: Dune (2021) (video)"),
            ({"problem": "playback", "title": "Dune", "code": None, "year": 2021}, "Fixed: Dune (2021) (playback)"),
            ({"problem": "wrong_file", "title": "Dune", "code": None, "year": "2021"},
             "Fixed: Dune (2021) (wrong file)"),
            ({"problem": "other", "title": "Dune", "code": "", "year": ""}, "Fixed: Dune"),
            ({"code": "S02E03", "year": 2022}, "Fixed: Severance S02E03 (subtitles)"),
            ({"problem": "other", "title": "Dune", "code": None, "year": 2021}, "Fixed: Dune (2021)"),
        ]
        for fields, want in cases:
            with self.subTest(fields=fields):
                self.assertEqual(activity_lines.fixed_line(self.body(**fields)), (want, "123"))
        self.assertEqual(activity_lines.fixed_line(self.body(ref=77))[1], "77")

    def test_only_the_title_is_cut_never_the_problem(self):
        # A 120-character title always fits in 200, so shrink the limit to see the cut.
        from app.services import library_lines
        with mock.patch.object(library_lines, "LINE_MAX", 40):
            line = activity_lines.fixed_line(self.body(title="The Long Title Words " * 5, problem="wrong_file"))[0]
        self.assertEqual(len(line), 40)
        self.assertTrue(line.startswith("Fixed: The Long"))
        self.assertTrue(line.endswith("… S02E03 (wrong file)"))

    def test_titles_that_could_show_a_person_an_address_or_a_token_are_refused(self):
        bad = ["Dune https://example.org/x", "see www.example.org", "plex.example.com", "Dune 192.168.1.10",
               "fe80::1 Dune", "jane@example.com", "thanks @jane", "/data/media/movies/Dune",
               "C:\\Movies\\Dune", "~/Movies/Dune", "Dune\\x", "a/b/c", "Dune deadbeefdeadbeef00",
               "Dune.2021.2160p.WEB-DL.DDP5.1", "Dune token AbCdEf0123456789XyZw", "A" * 121, "", "   ",
               None, 5, ["Dune"]]
        for title in bad:
            with self.subTest(title=title):
                with self.assertRaises(activity_lines.Refused):
                    activity_lines.fixed_line(self.body(title=title))

    def test_ordinary_titles_pass(self):
        for title in ("Face/Off", "Fahrenheit 9/11", "Mission: Impossible – Dead Reckoning", "WALL·E",
                      "M*A*S*H", "3:10 to Yuma", "Star Trek: Deep Space Nine", "Mr. Robot",
                      ("The Long Title Words " * 10)[:120]):
            with self.subTest(title=title):
                self.assertTrue(activity_lines.fixed_line(self.body(title=title, code=None))[0].startswith("Fixed: "))

    def test_only_the_allowed_kinds_problems_codes_years_and_refs(self):
        bad = [{"kind": "post_line"}, {"kind": None}, {"problem": "buffering"}, {"problem": None},
               {"code": "S2E3"}, {"code": "2x03"}, {"code": "S02E03 jane"}, {"code": 203}, {"year": 1700},
               {"year": "20211"}, {"year": True}, {"year": 2021.5}, {"ref": ""}, {"ref": None},
               {"ref": "a b"}, {"ref": "x" * 65}, {"ref": -1}, {"ref": True}]
        for fields in bad:
            with self.subTest(fields=fields):
                with self.assertRaises(activity_lines.Refused):
                    activity_lines.fixed_line(self.body(**fields))
        for body in ([], "x", None, 5):
            with self.assertRaises(activity_lines.Refused):
                activity_lines.fixed_line(body)


class KometaWords(unittest.TestCase):
    TYPES = {"Movies": "movie", "My Movies 4K": "movie", "TV Shows": "show", "Music": "artist"}

    def test_per_library_type(self):
        def kinds(*libraries):
            return activity_lines.poster_kinds(
                {"event": "run_end", "names": [{"name": "Spooky", "library": lib} for lib in libraries]}, self.TYPES)
        self.assertEqual(kinds("Movies", "TV Shows", "My Movies 4K"), ["movie", "show"])
        self.assertEqual(kinds("TV Shows"), ["show"])
        self.assertEqual(kinds("Music"), [], "typed, but neither movies nor shows")
        self.assertEqual(kinds("PLAYLIST"), [""], "nothing typed: one plain line")
        self.assertEqual(kinds(), [""])
        self.assertEqual(activity_lines.poster_kinds({"event": "run_end", "names": [{"library": "Movies"}]}, {}), [""],
                         "Plex didn't answer")
        self.assertEqual(activity_lines.poster_kinds({"event": "run_end", "names": "x"}, self.TYPES), [""])
        self.assertEqual([activity_lines.POSTERS[k] for k in ("movie", "show", "")],
                         ["Movie posters updated", "TV show posters updated", "Posters updated"])

    def test_only_run_end(self):
        self.assertTrue(activity_lines.is_run_end({"event": "run_end"}))
        for body in ({"event": "run_start"}, {"event": "changes"}, {"event": "error"}, {"event": "version"},
                     {"event": "delete"}, {}, [], None):
            self.assertFalse(activity_lines.is_run_end(body), body)


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class Requests(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.now = T0

    def ask(self, ref, title, minutes=0):
        self.now += timedelta(minutes=minutes)
        db = self.Session()
        try:
            return status_feed.record_request(db, ref, activity_lines.request_line(title, 2026), self.now)
        finally:
            db.close()

    def shown(self):
        db = self.Session()
        try:
            return [i["text"] for i in status_feed.feed(db, 30, self.now)["items"]]
        finally:
            db.close()

    def test_once_per_request(self):
        self.assertTrue(self.ask("seerr-request:1", "Dune Messiah"))
        self.assertFalse(self.ask("seerr-request:1", "Dune Messiah", minutes=1))
        self.assertEqual(self.shown(), ["Requested: Dune Messiah (2026)"])

    def test_two_lines_then_the_burst_folds_and_counts_on(self):
        self.ask("seerr-request:1", "One")
        self.ask("seerr-request:2", "Two", minutes=3)
        self.assertEqual(self.shown(), ["Requested: Two (2026)", "Requested: One (2026)"])
        self.ask("book-request:9:audiobook", "Three", minutes=3)
        self.assertEqual(self.shown(), ["Requested: 3 titles"])
        self.ask("seerr-request:4", "Four", minutes=3)
        self.ask("seerr-request:5", "Five", minutes=3)
        self.assertEqual(self.shown(), ["Requested: 5 titles"])
        db = self.Session()
        line = db.query(StatusUpdate).one()
        self.assertEqual(line.created_at, self.now, "the folded line moves to its newest request")
        self.assertEqual(line.started_at, T0)
        self.assertEqual({r.line_id for r in db.query(StatusEventRef)}, {line.id})
        db.close()

    def test_a_new_burst_once_the_first_line_is_15_minutes_old(self):
        for n in range(3):
            self.ask(f"seerr-request:{n}", f"T{n}", minutes=1)
        self.ask("seerr-request:10", "Later", minutes=15)
        self.assertEqual(self.shown(), ["Requested: Later (2026)", "Requested: 3 titles"])

    def test_old_records_go_with_the_lines(self):
        self.ask("seerr-request:1", "One")
        self.now += timedelta(days=31)
        poller_now = self.now
        with mock.patch.object(poller, "SessionLocal", self.Session), \
                mock.patch.object(status_feed, "now_utc", lambda: poller_now):
            poller.tidy_library_lines()
        db = self.Session()
        self.assertEqual((db.query(StatusUpdate).count(), db.query(StatusEventRef).count()), (0, 0))
        db.close()

    def test_library_lines_in_every_way(self):
        self.ask("seerr-request:1", "One")
        db = self.Session()
        try:
            body = status_feed.feed(db, 30, self.now)
            self.assertEqual(body["open"], [])
            self.assertEqual(body["items"][0]["source"], "library")
            self.assertEqual(body["items"][0]["note"], "")
            self.assertEqual(status_feed.due_pushes(db, self.now + timedelta(hours=1)), [])
            self.assertEqual(status_feed.state(True, True, body["open"]), "ok")
        finally:
            db.close()


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class RequestsAcrossWorkers(unittest.TestCase):
    """The other worker records a request of the same burst while this one is
    about to: the ref goes in first, so the fold sees both."""

    def test_the_burst_is_folded_once(self):
        from sqlalchemy import create_engine, event
        from app.database import Base
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        url = f"sqlite:///{os.path.join(tmp.name, 'feed.db')}"
        mine, other = create_engine(url), create_engine(url)
        self.addCleanup(mine.dispose)
        self.addCleanup(other.dispose)
        Base.metadata.create_all(bind=mine)

        def record(engine, ref, title, at):
            db = sessionmaker(bind=engine)()
            try:
                return status_feed.record_request(db, ref, activity_lines.request_line(title), at)
            finally:
                db.close()

        record(mine, "seerr-request:1", "One", T0)
        record(mine, "seerr-request:2", "Two", T0 + timedelta(minutes=1))
        raced = []

        def hook(conn, cursor, statement, parameters, context, executemany):
            if statement.startswith("INSERT INTO status_event_refs") and not raced:
                raced.append(statement)
                record(other, "seerr-request:3", "Three", T0 + timedelta(minutes=2))
        event.listen(mine, "before_cursor_execute", hook)
        self.addCleanup(event.remove, mine, "before_cursor_execute", hook)
        self.assertTrue(record(mine, "seerr-request:4", "Four", T0 + timedelta(minutes=2)))
        self.assertTrue(raced)
        db = sessionmaker(bind=mine)()
        self.assertEqual([r.message for r in db.query(StatusUpdate)], ["Requested: 4 titles"])
        db.close()


def seerr_request(rid, tmdb, kind="movie", status=2):
    return {"id": rid, "type": kind, "status": status, "media": {"tmdbId": tmdb, "status": 3},
            "requestedBy": {"email": "jane@example.com", "displayName": "Plex Jane", "username": "requester-jane"}}


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class SeerrRequests(unittest.TestCase):
    TITLES = {101: {"title": "Dune Messiah", "year": 2026}, 102: {"title": "Severance", "year": 2022},
              103: {"title": "Sinners", "year": 2025}}

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.lookup = mock.AsyncMock(side_effect=lambda items: {i["tmdb_id"]: self.TITLES[i["tmdb_id"]]
                                                                 for i in items if i["tmdb_id"] in self.TITLES})
        for p in (mock.patch.object(poller, "SessionLocal", self.Session),
                  mock.patch("app.integrations.seerr.lookup_titles", self.lookup),
                  mock.patch.object(status_feed, "now_utc", lambda: T0)):
            p.start()
            self.addCleanup(p.stop)

    def shown(self):
        db = self.Session()
        try:
            return [i["text"] for i in status_feed.feed(db, 30, T0)["items"]]
        finally:
            db.close()

    def seen(self):
        db = self.Session()
        try:
            return helpers.get(db, poller.SEERR_REQUESTS_SEEN_KEY)
        finally:
            db.close()

    def test_the_backlog_is_seeded_and_never_announced(self):
        backlog = [seerr_request(7, 101), seerr_request(5, 102, "tv")]
        self.assertEqual(run(poller.record_new_requests(backlog)), 0)
        self.assertEqual(self.seen(), "7")
        self.assertEqual(run(poller.record_new_requests(backlog)), 0, "a restart reads the same list again")
        self.assertEqual(self.shown(), [])
        self.lookup.assert_not_awaited()

    def test_new_requests_are_announced_once_without_who_asked(self):
        run(poller.record_new_requests([seerr_request(5, 103)]))
        later = [seerr_request(7, 102, "tv"), seerr_request(6, 101), seerr_request(5, 103)]
        self.assertEqual(run(poller.record_new_requests(later)), 2)
        self.assertEqual(run(poller.record_new_requests(later)), 0)
        self.assertEqual(self.shown(), ["Requested: Severance", "Requested: Dune Messiah (2026)"])
        self.assertEqual(self.seen(), "7")
        for word in PRIVATE:
            self.assertNotIn(word, "\n".join(self.shown()))

    def test_declined_and_untitled_requests_make_no_line(self):
        run(poller.record_new_requests([]))
        self.assertEqual(self.seen(), "0")
        run(poller.record_new_requests([seerr_request(1, 101, status=3), seerr_request(2, 999),
                                        seerr_request(3, 102, "tv")]))
        self.assertEqual(self.shown(), ["Requested: Severance"])
        self.assertEqual(self.seen(), "3")

    def test_when_seerr_names_none_the_next_cycle_tries_again(self):
        run(poller.record_new_requests([]))
        self.lookup.side_effect = lambda items: {}
        run(poller.record_new_requests([seerr_request(1, 101)]))
        self.assertEqual((self.shown(), self.seen()), ([], "0"))
        self.lookup.side_effect = None
        self.lookup.return_value = {101: self.TITLES[101]}
        run(poller.record_new_requests([seerr_request(1, 101)]))
        self.assertEqual(self.shown(), ["Requested: Dune Messiah (2026)"])

    def test_the_seerr_poll_writes_them(self):
        class Resp:
            status_code = 200

            def __init__(self, data):
                self._data = data

            def json(self):
                return self._data

        lists = [[seerr_request(1, 103)], [seerr_request(2, 101), seerr_request(1, 103)]]

        class Client:
            def __init__(self, **kw):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def get(self, url, **kw):
                return Resp({"results": lists[0]})

        with mock.patch.object(poller, "_get_seerr_config", return_value={"url": "http://seerr.invalid",
                                                                          "api_key": "k"}), \
                mock.patch.object(poller.httpx, "AsyncClient", Client):
            r = FakeRedis()
            run(poller._poll_seerr_requests(r))
            lists.pop(0)
            run(poller._poll_seerr_requests(r))
        self.assertEqual(self.shown(), ["Requested: Dune Messiah (2026)"])


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class BookRequests(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        for p in (mock.patch("app.routers.setup.is_setup_completed", return_value=True),
                  mock.patch("app.routers.integrations._enforce_daily_book_cap", mock.AsyncMock()),
                  mock.patch.object(status_feed, "now_utc", lambda: T0)):
            p.start()
            self.addCleanup(p.stop)
        self.client = helpers.api_client(self.Session, user=helpers.MEMBER, headers=helpers.SAME_ORIGIN)
        self.addCleanup(helpers.reset_overrides)

    def ask(self, answer, fmt="audiobook", book_id="814330"):
        with mock.patch("app.integrations.chaptarr.request_book", mock.AsyncMock(return_value=dict(answer))):
            return self.client.post("/api/integrations/chaptarr-request", json={"bookId": book_id, "format": fmt})

    def shown(self):
        db = self.Session()
        try:
            return [i["text"] for i in status_feed.feed(db, 30, T0)["items"]]
        finally:
            db.close()

    def test_a_new_book_request_makes_its_line(self):
        r = self.ask({"ok": True, "message": "Book requested", "title": "Dune Messiah"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"ok": True, "message": "Book requested"})
        self.ask({"ok": True, "message": "Book requested", "title": "Dune Messiah"})
        self.ask({"ok": True, "message": "Book requested", "title": "Dune Messiah"}, fmt="ebook")
        self.assertEqual(self.shown(), ["Requested: Dune Messiah (ebook)", "Requested: Dune Messiah (audiobook)"])
        self.assertNotIn("Sam", "\n".join(self.shown()))

    def test_already_there_or_refused_makes_none(self):
        self.assertEqual(self.ask({"ok": True, "message": "Already in your library"}).status_code, 200)
        self.assertEqual(self.ask({"ok": False, "message": "Could not reach Chaptarr"}).status_code, 400)
        self.assertEqual(self.shown(), [])

    def test_an_odd_book_id_still_makes_one_line(self):
        self.ask({"ok": True, "message": "Book requested", "title": "Dune"}, book_id="x/y z")
        self.ask({"ok": True, "message": "Book requested", "title": "Dune"}, book_id="x/y z")
        self.assertEqual(self.shown(), ["Requested: Dune (audiobook)"])

    def test_a_write_that_fails_never_fails_the_request(self):
        from sqlalchemy.exc import OperationalError
        boom = mock.Mock(side_effect=OperationalError("INSERT", {}, Exception("database is locked")))
        with mock.patch.object(status_feed, "record_request", boom):
            r = self.ask({"ok": True, "message": "Book requested", "title": "Dune Messiah"})
        self.assertEqual(r.status_code, 200)


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class Webhooks(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        db = self.Session()
        helpers.put(db, "integration.n8n.webhook_secret", N8N_SECRET)
        helpers.put(db, "integration.kometa.webhook_token", KOMETA_TOKEN)
        db.close()
        self.now = T0
        self.types = mock.AsyncMock(return_value={"Movies": "movie", "TV Shows": "show", "Music": "artist"})
        for p in (mock.patch("app.integrations.config.SessionLocal", self.Session),
                  mock.patch("app.routers.setup.is_setup_completed", return_value=True),
                  mock.patch("app.integrations.plex.library_types", self.types),
                  mock.patch.object(status_feed, "now_utc", lambda: self.now)):
            p.start()
            self.addCleanup(p.stop)
        self.client = helpers.api_client(self.Session)
        self.addCleanup(helpers.reset_overrides)

    def n8n(self, body=None, secret=N8N_SECRET, raw=None, **fields):
        if body is None:
            body = {"kind": "issue_fixed", "title": "Severance", "code": "S02E03", "year": None,
                    "problem": "subtitles", "ref": "123"}
            body.update(fields)
        headers = {} if secret is None else {"X-Webhook-Secret": secret}
        if raw is not None:
            return self.client.post("/api/webhooks/n8n", content=raw, headers=headers)
        return self.client.post("/api/webhooks/n8n", json=body, headers=headers)

    def kometa(self, body, token=KOMETA_TOKEN):
        return self.client.post(f"/api/webhooks/kometa/{token}", json=body)

    def lines(self):
        db = self.Session()
        try:
            return [i["text"] for i in status_feed.feed(db, 30, self.now)["items"]]
        finally:
            db.close()

    # --- n8n ---

    def test_n8n_writes_the_sentence_once_per_issue(self):
        r = self.n8n()
        self.assertEqual((r.status_code, r.content), (204, b""))
        self.assertEqual(self.n8n().status_code, 204)
        self.assertEqual(self.n8n(problem="playback", title="Dune", code=None, year=2021, ref=124).status_code, 204)
        self.assertEqual(self.lines(), ["Fixed: Dune (2021) (playback)", "Fixed: Severance S02E03 (subtitles)"])

    def test_n8n_needs_its_secret(self):
        for secret in (None, "", "wrong", N8N_SECRET + "x"):
            with self.subTest(secret=secret):
                self.assertEqual(self.n8n(secret=secret).status_code, 401)
        db = self.Session()
        helpers.put(db, "integration.n8n.webhook_secret", "")
        db.close()
        self.assertEqual(self.n8n(secret="").status_code, 401, "an empty secret refuses every call")
        self.assertEqual(self.lines(), [])

    def test_n8n_refuses_what_must_not_show_and_logs_no_body(self):
        with self.assertLogs("app.routers.activity_webhooks", level="INFO") as logs:
            for fields in ({"title": "jane@example.com"}, {"title": "/data/media/x"}, {"kind": "free_text"},
                           {"problem": "nope"}, {"code": "S2E3"}):
                with self.subTest(fields=fields):
                    self.assertEqual(self.n8n(**fields).status_code, 422)
        self.assertNotIn("jane", "\n".join(logs.output))
        self.assertNotIn("/data/media", "\n".join(logs.output))
        for raw in (b"not json", b"", b"[1]", b'"x"'):
            self.assertEqual(self.n8n(raw=raw).status_code, 422, raw)
        self.assertEqual(self.lines(), [])

    def test_n8n_is_capped_at_30_an_hour(self):
        codes = [self.n8n(ref=str(n)).status_code for n in range(31)]
        self.assertEqual(codes[:30], [204] * 30)
        self.assertEqual(codes[30], 429)
        self.assertEqual(self.n8n(ref="5").status_code, 204, "a repeat is still just a repeat")
        self.now += timedelta(hours=1, minutes=1)
        self.assertEqual(self.n8n(ref="99").status_code, 204)
        self.assertEqual(len(self.lines()), 31)

    def test_n8n_database_trouble_is_a_503(self):
        from sqlalchemy.exc import OperationalError
        boom = mock.Mock(side_effect=OperationalError("INSERT", {}, Exception("database is locked")))
        with mock.patch.object(status_feed, "record_line", boom):
            self.assertEqual(self.n8n().status_code, 503)

    # --- Kometa ---

    def run_end(self, *libraries):
        return {"event": "run_end", "start_time": "2026-10-07 11:30:00", "end_time": "2026-10-07 11:41:00",
                "run_time": "0:11:00", "collections_created": 0, "collections_modified": 2, "collections_deleted": 0,
                "items_added": 4, "items_removed": 1, "added_to_radarr": 0, "added_to_sonarr": 0,
                "names": [{"name": "Halloween Spooky Picks", "library": lib} for lib in libraries],
                "library_mapping_name": ""}

    def test_kometa_run_end_per_library_type(self):
        self.assertEqual(self.kometa(self.run_end("Movies", "TV Shows", "Music")).status_code, 204)
        self.assertEqual(sorted(self.lines()), ["Movie posters updated", "TV show posters updated"])
        for word in PRIVATE:
            self.assertNotIn(word, "\n".join(self.lines()))

    def test_kometa_falls_back_to_one_plain_line(self):
        self.types.return_value = {}
        self.assertEqual(self.kometa(self.run_end("Movies")).status_code, 204)
        self.assertEqual(self.lines(), ["Posters updated"])

    def test_kometa_ignores_every_other_event(self):
        for body in ({"event": "run_start", "start_time": "x"}, {"event": "changes", "collection": "Spooky",
                     "poster": "AAAA"}, {"event": "error", "error": "Traceback /config/x"},
                     {"event": "version", "current": "2.5.1"}, {"event": "delete", "message": "x"}, {}, [], "x"):
            with self.subTest(body=body):
                self.assertEqual(self.kometa(body).status_code, 204)
        self.assertEqual(self.lines(), [])
        self.types.assert_not_awaited()

    def test_kometa_needs_its_token(self):
        for token in ("wrong", KOMETA_TOKEN + "x", KOMETA_TOKEN[:-1]):
            self.assertEqual(self.kometa(self.run_end("Movies"), token=token).status_code, 401)
        db = self.Session()
        helpers.put(db, "integration.kometa.webhook_token", "")
        db.close()
        self.assertEqual(self.kometa(self.run_end("Movies"), token="x").status_code, 401)
        self.assertEqual(self.client.post("/api/webhooks/kometa/", json={}).status_code, 404)
        self.assertEqual(self.lines(), [])

    def test_kometa_once_per_type_per_six_hours(self):
        self.kometa(self.run_end("Movies"))
        self.now += timedelta(hours=1)
        self.kometa(self.run_end("Movies", "TV Shows"))
        self.assertEqual(sorted(self.lines()), ["Movie posters updated", "TV show posters updated"])
        self.now += timedelta(hours=5, minutes=1)
        self.kometa(self.run_end("Movies", "TV Shows"))
        self.assertEqual(sorted(self.lines()), ["Movie posters updated", "Movie posters updated",
                                                "TV show posters updated"])

    def test_kometa_a_window_boundary_lets_none_through_early(self):
        self.now = datetime(2026, 10, 7, 17, 59)
        self.kometa(self.run_end("Movies"))
        self.now = datetime(2026, 10, 7, 18, 1)
        self.kometa(self.run_end("Movies"))
        self.assertEqual(self.lines(), ["Movie posters updated"])

    def test_the_token_never_reaches_the_access_log(self):
        from app.routers.activity_webhooks import HideWebhookTokens
        record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
                                   ("1.2.3.4:5", "POST", f"/api/webhooks/kometa/{KOMETA_TOKEN}?x=1", "1.1", 204),
                                   None)
        self.assertTrue(HideWebhookTokens().filter(record))
        self.assertNotIn(KOMETA_TOKEN, record.getMessage())
        self.assertIn("/api/webhooks/kometa/…", record.getMessage())
        other = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
                                  ("1.2.3.4:5", "GET", "/api/status/feed", "1.1", 200), None)
        HideWebhookTokens().filter(other)
        self.assertIn("/api/status/feed", other.getMessage())
        self.assertTrue(any(isinstance(f, HideWebhookTokens) for f in logging.getLogger("uvicorn.access").filters))

    def test_the_arr_webhooks_still_answer_beside_them(self):
        self.assertEqual(self.client.post("/api/webhooks/lidarr", json={}).status_code, 404)
        self.assertEqual(self.client.post("/api/webhooks/sonarr", json={}).status_code, 401)


if __name__ == "__main__":
    unittest.main()
