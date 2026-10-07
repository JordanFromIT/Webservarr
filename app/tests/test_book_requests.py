"""
Book requests in "Where requests stand" (app/services/book_requests.py).

A book asked for on the Requests page is added to Chaptarr monitored and
searched for; nothing else records it. So a book request is a monitored book
with no file, worded with the film reason codes, from its own cache and its
own endpoint: Chaptarr being down answers 503 there and leaves the film and
show rows alone.
"""
import asyncio
import unittest
from datetime import datetime, timezone
from unittest import mock

try:
    import httpx

    from app.integrations import chaptarr
    from app.services import book_requests, request_status
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

NOW = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)


def book(id, title, fmt="ebook", monitored=True, files=0, release="2015-01-01T00:00:00Z",
         added="2026-09-20T00:00:00Z", **extra):
    b = {
        "id": id, "title": title, "mediaType": fmt, "monitored": monitored,
        "hasFiles": bool(files), "releaseDate": release, "added": added,
        "statistics": {"bookFileCount": files},
        "author": {"authorName": "An Author", "id": 99, "path": "/books/An Author"},
        "authorTitle": "author, an",
    }
    b.update(extra)
    return b


def queued(book_id, **extra):
    q = {"bookId": book_id, "status": "downloading", "trackedDownloadStatus": "ok",
         "trackedDownloadState": "downloading", "size": 1000, "sizeleft": 250,
         "downloadClient": "qbit", "indexer": "some indexer", "errorMessage": ""}
    q.update(extra)
    return q


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class WhichBooksAreRequests(unittest.TestCase):
    def rows(self, books, queue=()):
        return book_requests.build_rows(books, list(queue), NOW)

    def test_only_monitored_books_without_a_file(self):
        rows, _ = self.rows([
            book(1, "Wanted"),
            book(2, "Here already", files=1),
            book(3, "Author import, never asked for", monitored=False),
            # hasFiles missing but a file counted: still here.
            dict(book(4, "Counted file"), hasFiles=None, statistics={"bookFileCount": 3}),
        ])
        self.assertEqual([r["title"] for r in rows], ["Wanted"])

    def test_a_row_is_shaped_like_a_film_row(self):
        rows, _ = self.rows([book(7362, "The Adventures of Huckleberry Finn", fmt="audiobook",
                                  added="2026-10-05T02:22:30Z")])
        r = rows[0]
        self.assertEqual(r["request_id"], "book-7362")
        self.assertEqual(r["media_type"], "audiobook")
        self.assertEqual(r["author"], "An Author")
        self.assertEqual(r["requested_at"], "2026-10-05T02:22:30Z")
        self.assertEqual(r["reason_code"], "NO_RELEASE_FOUND")
        self.assertEqual(r["state_code"], request_status.REASON_TO_STATE["NO_RELEASE_FOUND"])
        self.assertIn(r["group"], set(request_status.STATE_TO_GROUP.values()))

    def test_no_identity_and_nothing_about_the_plumbing(self):
        rows, _ = self.rows([book(1, "A")], [queued(1, errorMessage="magnet failed at tracker.example")])
        text = repr(rows)
        for leak in ("qbit", "indexer", "magnet", "/books", "authorId", "user", "requested_by", "99"):
            self.assertNotIn(leak, text, leak)
        self.assertEqual(set(rows[0]), {"request_id", "media_type", "title", "author", "requested_at",
                                        "reason_code", "state_code", "group", "percent"})

    def test_an_unknown_format_reads_as_an_ebook(self):
        rows, _ = self.rows([book(1, "A", fmt="comic")])
        self.assertEqual(rows[0]["media_type"], "ebook")

    def test_oldest_request_first(self):
        rows, _ = self.rows([book(1, "New", added="2026-10-01T00:00:00Z"),
                             book(2, "Old", added="2026-08-01T00:00:00Z")])
        self.assertEqual([r["title"] for r in rows], ["Old", "New"])


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class StatusWords(unittest.TestCase):
    """Each Chaptarr state maps to the film reason code the page words."""

    def reason(self, b, q=None):
        return book_requests.classify_book(b, q, NOW)

    def test_searching_downloading_retrying_stuck_not_out(self):
        self.assertEqual(self.reason(book(1, "A")), "NO_RELEASE_FOUND")             # Searching
        self.assertEqual(self.reason(book(1, "A"), queued(1)), "DOWNLOADING")       # Downloading
        self.assertEqual(self.reason(book(1, "A"), queued(1, status="warning",
                                                         errorMessage="no peers")),
                         "DOWNLOAD_STALLED")                                        # Retrying
        self.assertEqual(self.reason(book(1, "A"), queued(1, trackedDownloadStatus="error")),
                         "DOWNLOAD_STALLED")
        self.assertEqual(self.reason(book(1, "A"), queued(1, trackedDownloadState="importPending",
                                                         trackedDownloadStatus="warning")),
                         "IMPORT_BLOCKED")                                          # Stuck
        self.assertEqual(self.reason(book(1, "A"), queued(1, trackedDownloadState="importing")),
                         "DOWNLOADING")
        self.assertEqual(self.reason(book(1, "A", release="2027-03-01T00:00:00Z")),
                         "NOT_RELEASED_YET")                                        # Not out yet

    def test_release_dates_a_day_or_two_out_or_missing_are_out(self):
        self.assertEqual(self.reason(book(1, "A", release="2026-10-07T00:00:00Z")), "NO_RELEASE_FOUND")
        self.assertEqual(self.reason(book(1, "A", release=None)), "NO_RELEASE_FOUND")
        self.assertEqual(self.reason(book(1, "A", release="not a date")), "NO_RELEASE_FOUND")

    def test_every_reason_used_has_a_state(self):
        for code in ("NO_RELEASE_FOUND", "DOWNLOADING", "DOWNLOAD_STALLED", "IMPORT_BLOCKED", "NOT_RELEASED_YET"):
            self.assertIn(code, request_status.REASON_TO_STATE)

    def test_progress_comes_from_the_queue(self):
        rows, _ = book_requests.build_rows([book(1, "A")], [queued(1, size=2000, sizeleft=500)], NOW)
        self.assertEqual(rows[0]["percent"], 75.0)
        rows, _ = book_requests.build_rows([book(1, "A")], [queued(1, size=0, sizeleft=0)], NOW)
        self.assertEqual(rows[0]["percent"], 0)
        rows, _ = book_requests.build_rows([book(1, "A")], [], NOW)
        self.assertNotIn("percent", rows[0])


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class SummaryCounts(unittest.TestCase):
    def test_counted_as_films_are_and_never_twice(self):
        _, s = book_requests.build_rows([
            book(1, "Searching"),
            book(2, "Downloading"),
            book(3, "Not out", release="2027-01-01T00:00:00Z"),
            book(4, "Arrived this month", files=1, added="2026-09-30T00:00:00Z"),
            book(5, "Arrived long ago", files=1, added="2025-01-01T00:00:00Z"),
            book(6, "Never asked for", monitored=False, added="2026-10-01T00:00:00Z"),
        ], [queued(2), queued(2, size=5)], NOW)
        self.assertEqual(s, {"in_progress": 2, "unreleased": 1, "added_recently": 4})


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class SummaryEndpoint(unittest.TestCase):
    """The library summary's queue figures carry the book requests."""

    def setUp(self):
        self.client = helpers.api_client(helpers.make_sessionmaker(), user=helpers.MEMBER)

    def tearDown(self):
        helpers.reset_overrides()

    def summary(self, book_snapshot):
        from app.routers import integrations
        patches = [
            mock.patch.object(integrations.sonarr, "library_summary",
                              mock.AsyncMock(return_value={"in_progress": 10, "added_recently": 1})),
            mock.patch.object(integrations.radarr, "library_summary",
                              mock.AsyncMock(return_value={"in_progress": 20, "unreleased": 7, "added_recently": 2})),
            mock.patch.object(integrations.chaptarr, "library_summary",
                              mock.AsyncMock(return_value={"ebooks": 21, "audiobooks": 36})),
            mock.patch.object(integrations.seerr, "request_insights", mock.AsyncMock(return_value={})),
            mock.patch.object(integrations.plex, "quality_breakdown", mock.AsyncMock(return_value={})),
            mock.patch.object(book_requests, "get_snapshot", book_snapshot),
            mock.patch.object(integrations, "_cache_get", mock.AsyncMock(return_value=None)),
            mock.patch.object(integrations, "_cache_set", mock.AsyncMock()),
        ]
        for p in patches:
            p.start()
        integrations._library_summary_cache.clear()
        try:
            r = self.client.get("/api/integrations/library-summary")
        finally:
            for p in patches:
                p.stop()
            integrations._library_summary_cache.clear()
        self.assertEqual(r.status_code, 200)
        return r.json()

    def test_book_requests_join_the_queue_figures(self):
        snap = {"items": [], "summary": {"in_progress": 3, "unreleased": 2, "added_recently": 5}}
        out = self.summary(mock.AsyncMock(return_value=snap))
        self.assertEqual((out["in_progress"], out["unreleased"], out["added_recently"]), (33, 9, 8))
        # The library figures stay what is on the server: nothing counted twice.
        self.assertEqual((out["ebooks"], out["audiobooks"]), (21, 36))

    def test_chaptarr_down_leaves_the_film_and_show_figures(self):
        out = self.summary(mock.AsyncMock(side_effect=book_requests.Unavailable("down")))
        self.assertEqual((out["in_progress"], out["unreleased"], out["added_recently"]), (30, 7, 3))


class _Resp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class _Client:
    """GET-only fake Chaptarr. Any other verb fails the test."""

    def __init__(self, answers, calls):
        self.answers, self.calls = answers, calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, params=None, headers=None):
        self.calls.append(url)
        answer = self.answers.get(url.rsplit("/api/v1/", 1)[-1])
        if isinstance(answer, Exception):
            raise answer
        return answer

    def __getattr__(self, verb):
        raise AssertionError(f"Chaptarr is read only here, not {verb}")


CFG = {"url": "http://chaptarr.invalid", "api_key": "k", "root_folder": "/e", "audiobook_root_folder": "/a",
       "quality_profile_id": "1", "metadata_profile_id": "1",
       "audiobook_quality_profile_id": "2", "audiobook_metadata_profile_id": "2"}


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class ReadingChaptarr(unittest.TestCase):
    def fetch(self, answers, cfg=CFG):
        calls = []
        with mock.patch.object(chaptarr, "_get_config", return_value=cfg), \
             mock.patch.object(chaptarr.httpx, "AsyncClient", lambda **kw: _Client(answers, calls)):
            return asyncio.run(chaptarr.wanted_books()), calls

    def test_get_only_books_and_queue(self):
        out, calls = self.fetch({"book": _Resp(200, [book(1, "A")]),
                                 "queue": _Resp(200, {"records": [queued(1)]})})
        self.assertEqual([b["id"] for b in out["books"]], [1])
        self.assertEqual(out["queue"][0]["bookId"], 1)
        self.assertEqual(len(calls), 2)

    def test_a_failed_queue_only_loses_the_queue(self):
        out, _ = self.fetch({"book": _Resp(200, [book(1, "A")]), "queue": _Resp(500, {})})
        self.assertEqual(out["queue"], [])
        out, _ = self.fetch({"book": _Resp(200, [book(1, "A")]), "queue": httpx.ConnectError("x")})
        self.assertEqual(out["queue"], [])

    def test_unreachable_or_refusing_is_unavailable(self):
        for answer in (httpx.ConnectError("no route"), _Resp(503, {}), _Resp(200, {"not": "a list"})):
            with self.assertRaises(chaptarr.ChaptarrUnavailable):
                self.fetch({"book": answer, "queue": _Resp(200, [])})

    def test_not_configured_is_none(self):
        out, calls = self.fetch({}, cfg=dict(CFG, url=None))
        self.assertIsNone(out)
        self.assertEqual(calls, [])


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class Endpoints(unittest.TestCase):
    """GET /api/request-status/books, and the film rows beside it."""

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.client = helpers.api_client(self.Session, user=helpers.MEMBER)

    def tearDown(self):
        helpers.reset_overrides()

    def test_rows_for_any_signed_in_viewer(self):
        snap = {"generated_at": "2026-10-06T00:00:00+00:00", "configured": True, "total": 1,
                "summary": {}, "items": [{"request_id": "book-1", "media_type": "ebook", "title": "A"}]}
        with mock.patch.object(book_requests, "get_cached_snapshot", mock.AsyncMock(return_value=snap)):
            r = self.client.get("/api/request-status/books")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["items"][0]["request_id"], "book-1")

    def test_chaptarr_down_is_503_and_the_films_still_answer(self):
        films = {"generated_at": "2026-10-06T00:00:00+00:00", "counts": {}, "total": 1,
                 "items": [{"request_id": 5, "media_type": "movie", "title": "A Film"}]}
        with mock.patch.object(book_requests, "get_cached_snapshot", mock.AsyncMock(return_value=None)), \
             mock.patch.object(book_requests, "_recently_down", mock.AsyncMock(return_value=False)), \
             mock.patch.object(book_requests, "_mark_down", mock.AsyncMock()) as marked, \
             mock.patch.object(chaptarr, "wanted_books",
                               mock.AsyncMock(side_effect=chaptarr.ChaptarrUnavailable("down"))), \
             mock.patch.object(request_status, "get_cached_snapshot", mock.AsyncMock(return_value=films)):
            books = self.client.get("/api/request-status/books")
            film_rows = self.client.get("/api/request-status/")
        self.assertEqual(books.status_code, 503)
        self.assertNotIn("down", books.text)          # no internals in the answer
        marked.assert_awaited()
        self.assertEqual(film_rows.status_code, 200)
        self.assertEqual(film_rows.json()["items"][0]["title"], "A Film")

    def test_recently_down_answers_503_without_asking_chaptarr_again(self):
        asked = mock.AsyncMock()
        with mock.patch.object(book_requests, "get_cached_snapshot", mock.AsyncMock(return_value=None)), \
             mock.patch.object(book_requests, "_recently_down", mock.AsyncMock(return_value=True)), \
             mock.patch.object(chaptarr, "wanted_books", asked):
            r = self.client.get("/api/request-status/books")
        self.assertEqual(r.status_code, 503)
        asked.assert_not_awaited()

    def test_not_configured_is_an_empty_list(self):
        stored = mock.AsyncMock()
        with mock.patch.object(book_requests, "get_cached_snapshot", mock.AsyncMock(return_value=None)), \
             mock.patch.object(book_requests, "_recently_down", mock.AsyncMock(return_value=False)), \
             mock.patch.object(book_requests, "_store", stored), \
             mock.patch.object(chaptarr, "wanted_books", mock.AsyncMock(return_value=None)):
            r = self.client.get("/api/request-status/books")
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.json()["items"], r.json()["configured"]), ([], False))

    def test_signed_out_is_refused(self):
        helpers.reset_overrides()
        from fastapi.testclient import TestClient
        from app.main import app
        helpers.set_rate_limits(False)
        try:
            r = TestClient(app).get("/api/request-status/books")
        finally:
            helpers.set_rate_limits(True)
        self.assertEqual(r.status_code, 401)


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class WarmerTakesBothTurns(unittest.TestCase):
    def test_a_failing_film_build_still_builds_the_books(self):
        from app.services import request_status_warmer as warmer
        built = []

        async def books():
            built.append("books")
            warmer._running = False
            return {}

        with mock.patch.object(warmer, "STARTUP_DELAY", 0), \
             mock.patch.object(warmer, "REFRESH_INTERVAL", 0), \
             mock.patch.object(warmer, "_claim_turn", mock.AsyncMock(return_value=True)), \
             mock.patch.object(request_status, "refresh", mock.AsyncMock(side_effect=RuntimeError("seerr down"))), \
             mock.patch.object(book_requests, "refresh", books):
            asyncio.run(warmer.start_warmer())
        self.assertEqual(built, ["books"])


if __name__ == "__main__":
    unittest.main()
