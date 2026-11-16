"""
The book page's request for a format a catalog book lacks
(chaptarr.request_missing_format): the book is found again in Chaptarr by its
title and author, and only the one work that is this book is asked for.

Chaptarr is faked at the HTTP layer (httpx.AsyncClient). The rows are shaped
on the live library's Jurassic Park (November 2026): the standalone work
hc:9724 with ebook row 8844 and audiobook row 8882, the "Jurassic Park & The
Lost World" omnibus rows 8925/8926 (unmonitored after a wrong grab), and the
script book whose title starts the same. The catalog's ebook names the author
"Michael Chrichton" (a typo in its metadata). Writes are only recorded by the
fake; no test reaches Chaptarr or Redis.
"""
import asyncio
import unittest
from unittest import mock

try:
    import httpx

    from app.integrations import chaptarr
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False


CONFIG = {
    "url": "http://chaptarr.invalid",
    "api_key": "k",
    "root_folder": "/ebooks",
    "audiobook_root_folder": "/audiobooks",
    "quality_profile_id": "1",
    "metadata_profile_id": "2",
    "audiobook_quality_profile_id": "2",
    "audiobook_metadata_profile_id": "1",
}

AUTHORS = [{"id": 27, "authorName": "Michael Crichton"}, {"id": 28, "authorName": "Michael Connelly"},
           {"id": 29, "authorName": "Scott Ciencin"}]


def row(id_, title, fbid, media, monitored=False, files=False, omnibus=False):
    return {"id": id_, "title": title, "foreignBookId": fbid, "mediaType": media, "monitored": monitored,
            "hasFiles": files, "isOmnibus": omnibus, "statistics": {"bookFileCount": 1 if files else 0}}


def jurassic(audio_monitored=False, audio_files=False, audio_row=True):
    rows = [
        row(8844, "Jurassic Park", "hc:9724", "ebook", True, True),
        row(8878, "Jurassic Park: The Official Script Book: Complete with Annotations and Illustrations",
            "gr:165154122", "ebook"),
        row(8918, "Jurassic Park: The Official Script Book: Complete with Annotations and Illustrations",
            "gr:165154122", "audiobook"),
        row(8925, "Jurassic Park & The Lost World ~ First Trade Edition", "hc:171709", "ebook", omnibus=True),
        row(8926, "Jurassic Park & The Lost World ~ First Trade Edition", "hc:171709", "audiobook", omnibus=True),
        row(8923, "The Lost World", "gr:1212784", "ebook", True, True),
    ]
    if audio_row:
        rows.append(row(8882, "Jurassic Park", "hc:9724", "audiobook", audio_monitored, audio_files))
    return rows


def search_result(fid, title, author, ebook_rows=(), audio_rows=()):
    return {"foreignId": fid, "book": {
        "title": title, "author": {"authorName": author}, "isOmnibus": False,
        "localEbookBooks": [{"id": i} for i in ebook_rows], "localAudiobookBooks": [{"id": i} for i in audio_rows]}}


SEARCH = [
    search_result("gr:3376836", "Jurassic Park (Jurassic Park, #1)", "Michael Crichton", [8844], [8882]),
    search_result("gr:6795128", "Michael Crichton's Jurassic World: Jurassic Park / The Lost World",
                  "Michael Crichton", [8925], [8926]),
    search_result("gr:1663175", "Jurassic Park III", "Scott Ciencin"),
]


class _Resp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class FakeChaptarr:
    """Answers the GETs from its tables and records every write."""

    def __init__(self, books, search=SEARCH, authors=AUTHORS, down=False, search_down=False):
        self.books, self.search, self.authors, self.down = books, search, authors, down
        self.search_down = search_down
        self.gets, self.writes = [], []

    def client(self, **kwargs):
        fake = self

        class Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def get(self, url, params=None, headers=None):
                if fake.down:
                    raise httpx.ConnectError("refused")
                path = url.replace(CONFIG["url"], "")
                fake.gets.append((path, dict(params or {})))
                if path == "/api/v1/author":
                    return _Resp(200, fake.authors)
                if path == "/api/v1/book":
                    return _Resp(200, fake.books if (params or {}).get("authorId") == 27 else [])
                if path == "/api/v1/search":
                    return _Resp(503, {}) if fake.search_down else _Resp(200, fake.search)
                return _Resp(404, {})

            async def put(self, url, headers=None, json=None):
                fake.writes.append(("PUT", url.replace(CONFIG["url"], ""), json))
                return _Resp(202, {})

            async def post(self, url, headers=None, json=None):
                fake.writes.append(("POST", url.replace(CONFIG["url"], ""), json))
                return _Resp(201, {})

        return Client()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class RequestMissingFormat(unittest.TestCase):
    def ask(self, fake, title="Jurassic Park", author="Michael Chrichton", fmt="audiobook", config=None,
            searched=False):
        self.request_book = mock.AsyncMock(return_value={"ok": True, "message": "Book requested", "title": "JP",
                                                         "state": "requested", "book_ids": [9001]})
        with mock.patch.object(chaptarr, "_get_config", return_value=dict(config or CONFIG)), \
             mock.patch.object(chaptarr.httpx, "AsyncClient", fake.client), \
             mock.patch.object(chaptarr, "_searched_recently", mock.AsyncMock(return_value=searched)), \
             mock.patch.object(chaptarr, "_mark_searched", mock.AsyncMock()), \
             mock.patch.object(chaptarr, "_cache_book", mock.AsyncMock()), \
             mock.patch.object(chaptarr, "request_book", self.request_book):
            return asyncio.run(chaptarr.request_missing_format(title, author, fmt))

    def test_the_audiobook_already_here_asks_for_nothing(self):
        # Live today: row 8882 has its file; the catalog's ebook only failed to pair.
        fake = FakeChaptarr(jurassic(audio_monitored=True, audio_files=True))
        result = self.ask(fake)
        self.assertEqual((result["ok"], result["state"]), (True, "available"))
        self.assertEqual(fake.writes, [])

    def test_the_standalone_row_is_monitored_and_searched_never_the_omnibus(self):
        fake = FakeChaptarr(jurassic())
        result = self.ask(fake)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["state"], "requested")
        self.assertEqual(result["book_ids"], [8882])
        self.assertEqual(fake.writes, [
            ("PUT", "/api/v1/book/monitor", {"bookIds": [8882], "monitored": True}),
            ("POST", "/api/v1/command", {"name": "BookSearch", "bookIds": [8882]}),
        ])
        self.request_book.assert_not_awaited()
        # Logged under the search result's id, as the Requests page logs Jurassic Park.
        self.assertEqual(result["foreign_id"], "gr:3376836")

    def test_the_log_id_falls_back_to_the_work_when_search_cannot_name_it(self):
        fake = FakeChaptarr(jurassic(), search_down=True)
        result = self.ask(fake)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["foreign_id"], "hc:9724")
        self.assertEqual(len(fake.writes), 2)                               # the request itself went through

    def test_the_ebook_the_same_way(self):
        books = jurassic(audio_monitored=True, audio_files=True)
        books[0] = row(8844, "Jurassic Park", "hc:9724", "ebook")
        fake = FakeChaptarr(books)
        result = self.ask(fake, author="Michael Crichton", fmt="ebook")
        self.assertEqual(result["book_ids"], [8844])
        self.assertEqual(fake.writes[0][2], {"bookIds": [8844], "monitored": True})

    def test_a_row_monitored_and_searched_lately_is_not_searched_again(self):
        fake = FakeChaptarr(jurassic(audio_monitored=True))
        result = self.ask(fake, searched=True)
        self.assertEqual((result["ok"], result["state"]), (True, "requested"))
        self.assertEqual(fake.writes, [])

    def test_a_series_marker_or_case_does_not_matter_but_a_longer_title_does(self):
        fake = FakeChaptarr(jurassic())
        self.assertEqual(self.ask(fake, title="JURASSIC PARK (Jurassic Park, #1)")["book_ids"], [8882])
        fake = FakeChaptarr(jurassic())
        result = self.ask(fake, title="Jurassic Park & The Lost World")
        self.assertTrue(result.get("not_found"), result)                  # only the omnibus has that title
        self.assertEqual(fake.writes, [])

    def test_two_works_of_one_title_are_told_apart_by_the_format_that_is_here(self):
        books = jurassic() + [row(9100, "Jurassic Park", "gr:999", "ebook"),
                              row(9101, "Jurassic Park", "gr:999", "audiobook")]
        fake = FakeChaptarr(books)
        self.assertEqual(self.ask(fake)["book_ids"], [8882])               # hc:9724's ebook has the file
        books = [r for r in books if r["id"] != 8844] + [row(8844, "Jurassic Park", "hc:9724", "ebook")]
        fake = FakeChaptarr(books)
        result = self.ask(fake)
        self.assertTrue(result.get("not_found"), result)                   # neither: no guess
        self.assertEqual(fake.writes, [])

    def test_a_work_without_a_row_in_this_format_goes_through_its_search_result(self):
        fake = FakeChaptarr(jurassic(audio_row=False))
        result = self.ask(fake)
        self.request_book.assert_awaited_once_with("gr:3376836", "audiobook")   # the result holding 8844
        self.assertEqual(result["foreign_id"], "gr:3376836")
        self.assertEqual(fake.writes, [])                                   # request_book's own (faked)

    def test_a_book_the_library_lacks_needs_one_exact_search_result(self):
        fake = FakeChaptarr([], search=[search_result("gr:1", "Sphere", "Michael Crichton"),
                                        search_result("gr:2", "Sphere: A Novel Summary", "Michael Crichton"),
                                        search_result("gr:3", "Sphere", "Someone Else")])
        self.ask(fake, title="Sphere", author="Michael Crichton")
        self.request_book.assert_awaited_once_with("gr:1", "audiobook")
        fake = FakeChaptarr([], search=[search_result("gr:1", "Sphere", "Michael Crichton"),
                                        search_result("gr:4", "Sphere (Reissue)", "Michael Crichton")])
        result = self.ask(fake, title="Sphere", author="Michael Crichton")
        self.assertTrue(result.get("not_found"), result)
        self.request_book.assert_not_awaited()

    def test_an_author_the_library_lacks_is_searched_for(self):
        fake = FakeChaptarr(jurassic(), search=[search_result("gr:7", "Congo", "Mary Doria Russell")])
        self.ask(fake, title="Congo", author="Mary Doria Russell")
        self.request_book.assert_awaited_once_with("gr:7", "audiobook")
        self.assertNotIn(("/api/v1/book", {"authorId": 27}), fake.gets)

    def test_chaptarr_down_or_not_set_up(self):
        result = self.ask(FakeChaptarr(jurassic(), down=True))
        self.assertEqual(result, {"ok": False, "message": "Could not reach Chaptarr"})
        fake = FakeChaptarr(jurassic())
        result = self.ask(fake, config=dict(CONFIG, audiobook_root_folder=""))
        self.assertFalse(result["ok"])
        self.assertEqual(fake.gets, [])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Matching(unittest.TestCase):
    def test_author_likeness(self):
        self.assertEqual(chaptarr._author_likeness("Michael Crichton", "michael crichton"), 1.0)
        self.assertEqual(chaptarr._author_likeness("Michael Chrichton", "Michael Crichton"), 0.5)
        self.assertEqual(chaptarr._author_likeness("Michael Crichton", "Michael Connelly"), 0.0)
        self.assertEqual(chaptarr._author_likeness("Douglas Preston, Lincoln Child", "Lincoln Child"), 1.0)
        self.assertEqual(chaptarr._author_likeness("J. R. R. Tolkien", "J.R.R. Tolkien"), 1.0)
        self.assertEqual(chaptarr._author_likeness("Charlotte Brontë", "Charlotte Bronte"), 1.0)

    def test_requested_formats_from_the_snapshot(self):
        items = [{"media_type": "audiobook", "title": "Jurassic Park", "author": "Michael Crichton"},
                 {"media_type": "ebook", "title": "Jurassic Park & The Lost World", "author": "Michael Crichton"},
                 {"media_type": "ebook", "title": "Jurassic Park", "author": "Scott Ciencin"}]
        self.assertEqual(chaptarr.requested_formats(items, "Jurassic Park", "Michael Chrichton"), {"audiobook"})
        self.assertEqual(chaptarr.requested_formats([], "Jurassic Park", "Michael Crichton"), set())


if __name__ == "__main__":
    unittest.main()
