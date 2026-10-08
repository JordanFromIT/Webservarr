"""
A book request reaches Chaptarr for real, or says why not.

Adding one book of a new author imports all of that author's books into
Chaptarr unmonitored. Requesting a second one (Darth Bane 2 and 3, after 1)
posted it as a new book again: Chaptarr answered 200, nothing was monitored or
searched, and the page showed success and then "Request" again on every
refresh. An "already added" refusal was likewise reported as success. Now a
book Chaptarr already holds is monitored and searched (its own UI's two
calls), its library rows are re-read at request time rather than taken from
the search's cached copy, and a refusal is an error. Search results carry each
format's real state ("searching", "downloading", ...) for the cards and the
book detail.
"""
import asyncio
import json as _json
import unittest
from unittest import mock

try:
    from app.integrations import chaptarr
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False


CONFIG = {
    "url": "http://chaptarr.invalid",
    "api_key": "k",
    "root_folder": "/ebooks",
    "audiobook_root_folder": "/audiobooks",
    "quality_profile_id": "1",
    "metadata_profile_id": "1",
    "audiobook_quality_profile_id": "2",
    "audiobook_metadata_profile_id": "2",
}

TITLE = "Rule of Two (Star Wars: Darth Bane, #2)"


def _book(ebook_rows=None, audio_rows=None):
    return {
        "foreignBookId": "gr:3341500",
        "title": TITLE,
        "mediaType": "audiobook",
        "author": {"foreignAuthorId": "hc:200904", "authorName": "Drew Karpyshyn"},
        "localEbookBooks": ebook_rows or [],
        "localAudiobookBooks": audio_rows or [],
    }


class _Resp:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body
        self.text = "" if body is None else _json.dumps(body)

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


class _Chaptarr:
    """A scripted Chaptarr: `search` is the lookup's result list; answers for
    the writes by (method, path). Every call is recorded; an unscripted write
    fails the test rather than reaching anything real."""

    def __init__(self, search, answers=None):
        self.search = search
        self.answers = answers or {}
        self.calls = []

    def client(self, **kwargs):
        outer = self

        class _Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def get(self, url, params=None, headers=None):
                outer.calls.append(("GET", url.split("/api/v1")[1], params))
                # A callable search answers by what has been written so far.
                return _Resp(200, outer.search(outer) if callable(outer.search) else outer.search)

            async def post(self, url, headers=None, json=None):
                return outer._write("POST", url, json)

            async def put(self, url, headers=None, json=None):
                return outer._write("PUT", url, json)

        return _Client()

    def _write(self, method, url, body):
        path = url.split("/api/v1")[1]
        self.calls.append((method, path, body))
        if (method, path) not in self.answers:
            raise AssertionError(f"unscripted {method} {path}")
        return self.answers[(method, path)]

    def writes(self):
        return [(m, p, b) for (m, p, b) in self.calls if m != "GET"]


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class RequestBook(unittest.TestCase):
    def _request(self, fake, fmt="ebook", cached=None):
        with mock.patch.object(chaptarr, "_get_config", return_value=dict(CONFIG)), \
             mock.patch.object(chaptarr, "_get_cached_book", mock.AsyncMock(return_value=cached)), \
             mock.patch.object(chaptarr, "_cache_book", mock.AsyncMock()), \
             mock.patch.object(chaptarr.httpx, "AsyncClient", fake.client):
            return asyncio.run(chaptarr.request_book("gr:3341500", fmt=fmt))

    def test_a_book_chaptarr_holds_unmonitored_is_monitored_and_searched(self):
        # The search's cached copy predates the author import: no rows. The
        # fresh lookup has them.
        fake = _Chaptarr(
            [{"foreignId": "gr:3341500", "book": _book([{"id": 8059, "monitored": False, "hasFiles": False}],
                                                       [{"id": 8075, "monitored": False, "hasFiles": False}])}],
            {("PUT", "/book/monitor"): _Resp(202, []), ("POST", "/command"): _Resp(201, {"id": 1})})
        result = self._request(fake, cached=_book())
        self.assertEqual(result, {"ok": True, "message": "Book requested", "title": TITLE, "state": "requested"})
        self.assertEqual(fake.writes(), [
            ("PUT", "/book/monitor", {"bookIds": [8059], "monitored": True}),
            ("POST", "/command", {"name": "BookSearch", "bookIds": [8059]}),
        ])

    def test_the_audiobook_request_takes_the_audiobook_row(self):
        fake = _Chaptarr(
            [{"foreignId": "gr:3341500", "book": _book([{"id": 8059, "monitored": False}],
                                                       [{"id": 8075, "monitored": False}])}],
            {("PUT", "/book/monitor"): _Resp(202, []), ("POST", "/command"): _Resp(201, {"id": 1})})
        self.assertTrue(self._request(fake, fmt="audiobook", cached=_book())["ok"])
        self.assertEqual(fake.writes()[0][2], {"bookIds": [8075], "monitored": True})

    def test_the_lookup_searches_the_title_not_the_id(self):
        # The id as a search term finds the library's own copy under another
        # provider's id, never the result that was picked.
        fake = _Chaptarr([])
        fake.answers[("POST", "/book")] = _Resp(201, {"id": 9000, "monitored": True})
        self._request(fake, cached=_book())
        gets = [c for c in fake.calls if c[0] == "GET"]
        self.assertEqual(gets[0][2]["term"], TITLE)

    def test_one_already_here_needs_no_write(self):
        fake = _Chaptarr([{"foreignId": "gr:3341500", "book": _book([{"id": 8062, "monitored": True, "hasFiles": True}])}])
        result = self._request(fake, cached=_book())
        self.assertEqual(result, {"ok": True, "message": "Already in the library", "state": "available"})
        self.assertEqual(fake.writes(), [])

    def test_a_new_book_is_added(self):
        fake = _Chaptarr([], {("POST", "/book"): _Resp(201, {"id": 9000, "monitored": True})})
        result = self._request(fake, cached=_book())
        self.assertEqual(result["state"], "requested")
        self.assertEqual([w[:2] for w in fake.writes()], [("POST", "/book")])
        self.assertEqual(fake.writes()[0][2]["mediaType"], "ebook")

    def test_an_add_answered_with_an_unmonitored_record_is_monitored_and_searched(self):
        # 200 with the record it already had, unchanged: not a request yet.
        fake = _Chaptarr([], {("POST", "/book"): _Resp(200, {"id": 8059, "monitored": False}),
                              ("PUT", "/book/monitor"): _Resp(202, []),
                              ("POST", "/command"): _Resp(201, {"id": 1})})
        result = self._request(fake, cached=_book())
        self.assertTrue(result["ok"])
        self.assertEqual([w[:2] for w in fake.writes()],
                         [("POST", "/book"), ("PUT", "/book/monitor"), ("POST", "/command")])
        self.assertEqual(fake.writes()[1][2]["bookIds"], [8059])

    def test_already_added_is_an_error_not_a_success(self):
        fake = _Chaptarr([], {("POST", "/book"): _Resp(400, [{"errorMessage": "This book has already been added."}])})
        result = self._request(fake, cached=_book())
        self.assertEqual(result, {"ok": False, "message": "This book has already been added."})

    def test_a_refused_monitor_is_an_error_and_no_search_starts(self):
        fake = _Chaptarr(
            [{"foreignId": "gr:3341500", "book": _book([{"id": 8059, "monitored": False}])}],
            {("PUT", "/book/monitor"): _Resp(400, [{"errorMessage": "Book does not exist"}])})
        result = self._request(fake, cached=_book())
        self.assertEqual(result, {"ok": False, "message": "Book does not exist"})
        self.assertEqual([w[:2] for w in fake.writes()], [("PUT", "/book/monitor")])

    def test_a_search_that_does_not_start_is_an_error(self):
        fake = _Chaptarr(
            [{"foreignId": "gr:3341500", "book": _book([{"id": 8059, "monitored": False}])}],
            {("PUT", "/book/monitor"): _Resp(202, []), ("POST", "/command"): _Resp(500, None)})
        result = self._request(fake, cached=_book())
        self.assertFalse(result["ok"])
        self.assertIn("did not start", result["message"])

    def test_unknown_book_is_an_error(self):
        result = self._request(_Chaptarr([]), cached=None)
        self.assertEqual(result, {"ok": False, "message": "Could not find that book in Chaptarr"})


def _found(ebook_rows=None, audio_rows=None):
    return [{"foreignId": "gr:3341500", "book": _book(ebook_rows, audio_rows)}]


_MONITOR_AND_SEARCH = {("PUT", "/book/monitor"): _Resp(202, []), ("POST", "/command"): _Resp(201, {"id": 1})}


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class RequestBothFormats(unittest.TestCase):
    """The Requests page's one Request button: the book, in every format the
    server takes and does not have yet, in as few writes as Chaptarr allows."""

    def _request(self, fake, cached=None, config=None):
        with mock.patch.object(chaptarr, "_get_config", return_value=dict(config or CONFIG)), \
             mock.patch.object(chaptarr, "_get_cached_book", mock.AsyncMock(return_value=cached)), \
             mock.patch.object(chaptarr, "_cache_book", mock.AsyncMock()), \
             mock.patch.object(chaptarr.httpx, "AsyncClient", fake.client):
            return asyncio.run(chaptarr.request_book("gr:3341500", fmt="both"))

    def test_both_rows_held_are_monitored_and_searched_together(self):
        fake = _Chaptarr(_found([{"id": 8059, "monitored": False}], [{"id": 8075, "monitored": False}]),
                         dict(_MONITOR_AND_SEARCH))
        result = self._request(fake, cached=_book())
        self.assertEqual(result, {"ok": True, "message": "Book requested", "state": "requested", "title": TITLE,
                                  "states": {"ebook": "requested", "audiobook": "requested"}})
        self.assertEqual(fake.writes(), [
            ("PUT", "/book/monitor", {"bookIds": [8059, 8075], "monitored": True}),
            ("POST", "/command", {"name": "BookSearch", "bookIds": [8059, 8075]}),
        ])

    def test_a_format_already_here_is_left_alone(self):
        fake = _Chaptarr(_found([{"id": 8059, "monitored": True, "hasFiles": True}], [{"id": 8075, "monitored": False}]),
                         dict(_MONITOR_AND_SEARCH))
        result = self._request(fake, cached=_book())
        self.assertEqual(result["states"], {"ebook": "available", "audiobook": "requested"})
        self.assertEqual(fake.writes()[0][2], {"bookIds": [8075], "monitored": True})

    def test_both_here_needs_no_write(self):
        fake = _Chaptarr(_found([{"id": 8059, "hasFiles": True}], [{"id": 8075, "hasFiles": True}]))
        result = self._request(fake, cached=_book())
        self.assertEqual(result, {"ok": True, "message": "Already in the library", "state": "available",
                                  "states": {"ebook": "available", "audiobook": "available"}})
        self.assertEqual(fake.writes(), [])

    def test_one_add_that_brings_the_other_format_is_not_added_twice(self):
        # Chaptarr keeps both: adding the ebook makes the audiobook's row too,
        # monitored. The book is read again, and the audiobook is taken as is.
        def search(fake):
            if not fake.writes():
                return []
            return _found([{"id": 9000, "monitored": True}], [{"id": 9001, "monitored": True}])
        fake = _Chaptarr(search, {("POST", "/book"): _Resp(201, {"id": 9000, "monitored": True})})
        result = self._request(fake, cached=_book())
        self.assertEqual([w[:2] for w in fake.writes()], [("POST", "/book")])
        self.assertEqual(fake.writes()[0][2]["mediaType"], "ebook")
        self.assertEqual(result["states"], {"ebook": "requested", "audiobook": "requested"})
        self.assertEqual(result["title"], TITLE)

    def test_an_add_that_brings_nothing_more_adds_the_other_format(self):
        fake = _Chaptarr([], {("POST", "/book"): _Resp(201, {"id": 9000, "monitored": True})})
        result = self._request(fake, cached=_book())
        self.assertEqual([w[2]["mediaType"] for w in fake.writes()], ["ebook", "audiobook"])
        self.assertEqual(fake.writes()[1][2]["rootFolderPath"], "/audiobooks")
        self.assertEqual(result["states"], {"ebook": "requested", "audiobook": "requested"})

    def test_an_unmonitored_row_the_add_brought_is_monitored_and_searched(self):
        def search(fake):
            if not fake.writes():
                return []
            return _found([{"id": 9000, "monitored": True}], [{"id": 9001, "monitored": False}])
        answers = dict(_MONITOR_AND_SEARCH)
        answers[("POST", "/book")] = _Resp(201, {"id": 9000, "monitored": True})
        fake = _Chaptarr(search, answers)
        result = self._request(fake, cached=_book())
        self.assertEqual([w[:2] for w in fake.writes()], [("POST", "/book"), ("PUT", "/book/monitor"), ("POST", "/command")])
        self.assertEqual(fake.writes()[1][2]["bookIds"], [9001])
        self.assertEqual(result["states"]["audiobook"], "requested")

    def test_a_format_without_a_root_folder_is_not_asked_for(self):
        config = dict(CONFIG, audiobook_root_folder="")
        fake = _Chaptarr(_found([{"id": 8059, "monitored": False}], [{"id": 8075, "monitored": False}]),
                         dict(_MONITOR_AND_SEARCH))
        result = self._request(fake, cached=_book(), config=config)
        self.assertEqual(fake.writes()[0][2]["bookIds"], [8059])
        self.assertEqual(result["states"], {"ebook": "requested", "audiobook": None})

    def test_no_root_folder_at_all_is_an_error(self):
        config = dict(CONFIG, root_folder="", audiobook_root_folder="")
        result = self._request(_Chaptarr([]), cached=_book(), config=config)
        self.assertEqual(result, {"ok": False, "message": "No Chaptarr root folder configured"})

    def test_one_format_refused_is_still_the_other_requested(self):
        answers = {("POST", "/book"): _Resp(201, {"id": 9000, "monitored": True})}

        class _Picky(_Chaptarr):
            def _write(self, method, url, body):
                if method == "POST" and url.endswith("/book") and body.get("mediaType") == "audiobook":
                    self.calls.append((method, "/book", body))
                    return _Resp(400, [{"errorMessage": "No audiobook edition"}])
                return super()._write(method, url, body)

        fake = _Picky([], answers)
        result = self._request(fake, cached=_book())
        self.assertTrue(result["ok"])
        self.assertEqual(result["states"], {"ebook": "requested", "audiobook": None})

    def test_everything_refused_is_an_error(self):
        fake = _Chaptarr(_found([{"id": 8059, "monitored": False}], [{"id": 8075, "monitored": False}]),
                         {("PUT", "/book/monitor"): _Resp(400, [{"errorMessage": "Book does not exist"}])})
        result = self._request(fake, cached=_book())
        self.assertEqual(result, {"ok": False, "message": "Book does not exist"})


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class FormatStates(unittest.TestCase):
    def test_states_from_rows_and_the_request_snapshot(self):
        st = chaptarr._format_state
        self.assertIsNone(st([]))
        self.assertIsNone(st(None))
        self.assertIsNone(st([{"id": 1, "monitored": False, "hasFiles": False}]))
        self.assertEqual(st([{"id": 1, "monitored": True, "hasFiles": True}]), "available")
        self.assertEqual(st([{"id": 1, "monitored": False, "hasFiles": True}]), "available")
        # Monitored and not yet in the snapshot: just asked for.
        self.assertEqual(st([{"id": 1, "monitored": True}]), "requested")
        self.assertEqual(st([{"id": 1, "monitored": True}], {2: "DOWNLOADING"}), "requested")
        for code, word in (("NO_RELEASE_FOUND", "searching"), ("DOWNLOADING", "downloading"),
                           ("DOWNLOAD_STALLED", "retrying"), ("IMPORT_BLOCKED", "stuck"),
                           ("NOT_RELEASED_YET", "unreleased")):
            self.assertEqual(st([{"id": 1, "monitored": True}], {1: code}), word, code)

    def test_search_results_carry_both_formats_and_the_series(self):
        result = {"foreignId": "gr:3341500",
                  "book": _book([{"id": 8059, "monitored": True, "hasFiles": False}],
                                [{"id": 8075, "monitored": False, "hasFiles": False}])}
        with mock.patch.object(chaptarr, "_cache_book", mock.AsyncMock()):
            card = asyncio.run(chaptarr._normalise(result, reasons={8059: "NO_RELEASE_FOUND"}))
        self.assertEqual(card["states"], {"ebook": "searching", "audiobook": None})
        self.assertEqual(card["media_status"], "processing")
        self.assertEqual((card["short_title"], card["series"], card["series_number"]),
                         ("Rule of Two", "Star Wars: Darth Bane", "2"))

    def test_series_split(self):
        split = chaptarr._split_series
        self.assertEqual(split("The Darth Bane Series (Star Wars: Darth Bane #1-3)"),
                         ("The Darth Bane Series", "Star Wars: Darth Bane", "1-3"))
        self.assertEqual(split("Dune"), ("Dune", "", ""))
        self.assertEqual(split("A Book (Annotated)"), ("A Book (Annotated)", "", ""))

    def test_search_reads_the_cached_snapshot(self):
        snap = {"items": [{"request_id": "book-8059", "reason_code": "DOWNLOADING"},
                          {"request_id": "book-x", "reason_code": "DOWNLOADING"}]}
        with mock.patch("app.services.book_requests.get_cached_snapshot", mock.AsyncMock(return_value=snap)):
            self.assertEqual(asyncio.run(chaptarr._request_reasons()), {8059: "DOWNLOADING"})
        with mock.patch("app.services.book_requests.get_cached_snapshot", mock.AsyncMock(return_value=None)):
            self.assertEqual(asyncio.run(chaptarr._request_reasons()), {})


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Routes(unittest.TestCase):
    """The request route passes the state through and a refusal is a 400 with
    Chaptarr's reason; the detail's library line finds only what the caller
    can open."""

    def setUp(self):
        from app.tests import helpers
        self.helpers = helpers
        self.Session = helpers.make_sessionmaker()
        for p in (mock.patch("app.routers.setup.is_setup_completed", return_value=True),
                  mock.patch("app.routers.integrations._enforce_daily_book_cap", mock.AsyncMock())):
            p.start()
            self.addCleanup(p.stop)
        self.client = helpers.api_client(self.Session, user=helpers.MEMBER, headers=helpers.SAME_ORIGIN)
        self.addCleanup(helpers.reset_overrides)

    def ask(self, answer):
        with mock.patch("app.integrations.chaptarr.request_book", mock.AsyncMock(return_value=dict(answer))):
            return self.client.post("/api/integrations/chaptarr-request", json={"bookId": "gr:3341500", "format": "ebook"})

    def test_the_state_reaches_the_page(self):
        r = self.ask({"ok": True, "message": "Book requested", "title": TITLE, "state": "requested"})
        self.assertEqual((r.status_code, r.json()), (200, {"ok": True, "message": "Book requested", "state": "requested"}))
        r = self.ask({"ok": True, "message": "Already in the library", "state": "available"})
        self.assertEqual(r.json()["state"], "available")

    def test_both_formats_reach_chaptarr_as_one_request(self):
        answer = {"ok": True, "message": "Book requested", "title": TITLE, "state": "requested",
                  "states": {"ebook": "requested", "audiobook": "requested"}}
        with mock.patch("app.integrations.chaptarr.request_book", mock.AsyncMock(return_value=dict(answer))) as asked:
            r = self.client.post("/api/integrations/chaptarr-request", json={"bookId": "gr:3341500", "format": "both"})
        self.assertEqual(asked.await_args.kwargs.get("fmt"), "both")
        self.assertEqual(r.json()["states"], {"ebook": "requested", "audiobook": "requested"})
        self.assertNotIn("title", r.json())

    def test_a_refusal_is_a_400_with_the_reason(self):
        r = self.ask({"ok": False, "message": "This book has already been added."})
        self.assertEqual((r.status_code, r.json()["detail"]), (400, "This book has already been added."))

    def _row(self, book_id, title, author, ebook=True):
        from datetime import datetime
        from app.services.book_catalog import CatalogRow
        return CatalogRow(id=book_id, title=title, sort_title=title, author=author, series="", series_number=None,
                          added_at=None, updated_at=datetime(2026, 1, 1), kavita_chapter_id=1, kavita_series_id=1,
                          plex_book_key=None, cover_source="kavita", kavita_volume_id=None, ebook=ebook, audio=False)

    def find(self, rows, title, author="Drew Karpyshyn"):
        from app.routers import books as books_router
        scope = books_router.Scope(identity="plex:1", series={1}, audio=False)
        with mock.patch("app.routers.books.scope_of", mock.AsyncMock(return_value=scope)), \
             mock.patch("app.services.book_catalog.visible_rows", return_value=rows) as seen:
            r = self.client.get("/api/integrations/book-in-library", params={"title": title, "author": author})
        self.assertEqual(seen.call_args[0][1:], ({1}, False))   # the caller's own scope
        return r

    def test_the_library_line_finds_the_books_entry(self):
        rows = [self._row(7, "Revan", "Drew Karpyshyn"), self._row(24, "Path of Destruction", "Drew Karpyshyn")]
        r = self.find(rows, "path of destruction")
        self.assertEqual((r.status_code, r.json()), (200, {"book_id": 24, "formats": ["ebook"]}))
        # A subtitle on either side does not matter.
        self.assertEqual(self.find([self._row(3, "Dune: Deluxe Edition", "Frank Herbert")], "Dune", "Frank Herbert").json()["book_id"], 3)

    def test_another_author_or_nothing_visible_is_no_line(self):
        rows = [self._row(24, "Path of Destruction", "Someone Else")]
        self.assertEqual(self.find(rows, "Path of Destruction").json(), {})
        self.assertEqual(self.find([], "Path of Destruction").json(), {})


if __name__ == "__main__":
    unittest.main()
