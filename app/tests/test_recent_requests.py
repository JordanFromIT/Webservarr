"""
Home's Recent Requests panel answers quickly (GET /api/integrations/recent-requests).

Seerr's half is one call. The books half lists every author's files from
Chaptarr, which took over five seconds one author at a time, plus the whole
book list (tens of thousands of rows, about seven seconds) just to title ten
rows. So the per-author listing runs a few at a time, only the shown books
are titled, and the result is kept in one shared copy that is served at once
and rebuilt behind the viewer when it gets old. Everything here is faked: no
Chaptarr, Seerr or Redis is reached.
"""
import asyncio
import time
import unittest
from unittest import mock

try:
    import httpx

    from app.integrations import chaptarr
    from app.routers import integrations
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

CFG = {"url": "http://chaptarr.invalid", "api_key": "k"}


class _Resp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class _Chaptarr:
    """GET-only fake Chaptarr that records concurrency. Any other verb fails."""

    def __init__(self, authors, files_by_author, books=(), fail_author=None):
        self.authors = authors
        self.files_by_author = files_by_author
        self.books = {b["id"]: b for b in books}
        self.fail_author = fail_author
        self.calls = []
        self.in_flight = 0
        self.most_in_flight = 0
        self.finished = 0

    def client(self, **kw):
        return _Client(self)


class _Client:
    def __init__(self, fake):
        self.fake = fake

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, params=None, headers=None):
        fake = self.fake
        path = url.rsplit("/api/v1/", 1)[-1]
        fake.calls.append((path, params))
        if path == "author":
            return _Resp(200, [{"id": a} for a in fake.authors])
        if path == "bookfile":
            fake.in_flight += 1
            fake.most_in_flight = max(fake.most_in_flight, fake.in_flight)
            try:
                await asyncio.sleep(0.01)
                if params["authorId"] == fake.fail_author:
                    raise httpx.ConnectError("refused")
                return _Resp(200, fake.files_by_author.get(params["authorId"], []))
            finally:
                fake.in_flight -= 1
                fake.finished += 1
        if path == "book":
            ids = (params or {}).get("bookIds")
            if ids is None:
                raise AssertionError("the unfiltered book list is never read")
            return _Resp(200, [fake.books[i] for i in ids if i in fake.books])
        raise AssertionError(f"unexpected Chaptarr call {path}")

    def __getattr__(self, verb):
        raise AssertionError(f"Chaptarr is read only here, not {verb}")


def _file(book_id, added, path="/books/ebooks/x.epub"):
    return {"bookId": book_id, "dateAdded": added, "path": path}


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class ListingBookFiles(unittest.TestCase):
    def run_with(self, fake, coro_fn):
        with mock.patch.object(chaptarr, "_get_config", return_value=dict(CFG)), \
             mock.patch.object(chaptarr.httpx, "AsyncClient", fake.client):
            return asyncio.run(coro_fn())

    def test_authors_are_listed_a_few_at_a_time_in_author_order(self):
        authors = list(range(1, 21))
        fake = _Chaptarr(authors, {a: [_file(a, f"2026-01-{a:02d}")] for a in authors})
        files = self.run_with(fake, chaptarr._book_files)
        self.assertEqual([f["bookId"] for f in files], authors)
        self.assertEqual(fake.most_in_flight, chaptarr._BOOK_FILES_CONCURRENCY)

    def test_one_author_failing_fails_the_listing_after_every_call_ends(self):
        authors = list(range(1, 21))
        fake = _Chaptarr(authors, {a: [_file(a, "2026-01-01")] for a in authors}, fail_author=3)
        self.assertEqual(self.run_with(fake, chaptarr._book_files), [])
        self.assertEqual(fake.finished, len(authors))

    def test_only_the_books_shown_are_titled(self):
        files = {
            1: [_file(10, "2026-10-01T00:00:00Z"), _file(10, "2026-09-01T00:00:00Z")],
            2: [_file(20, "2026-10-03T00:00:00Z", "/books/audiobooks/a/01.mp3"),
                _file(30, "2026-08-01T00:00:00Z")],
        }
        books = [{"id": 10, "title": "Ten", "authorTitle": "one, author"},
                 {"id": 20, "title": "Twenty", "authorTitle": "two, author"},
                 {"id": 30, "title": "Thirty", "authorTitle": "three, author"}]
        fake = _Chaptarr([1, 2], files, books)
        out = self.run_with(fake, lambda: chaptarr.recent_requests(limit=2))
        self.assertEqual(out, [
            {"id": 20, "media_title": "Twenty", "media_type": "audiobook", "poster_url": "",
             "author": "two, author", "status": "available",
             "requested_date": "2026-10-03T00:00:00Z", "updated_date": "2026-10-03T00:00:00Z"},
            # Dated by its earliest file, so it sorts below the audiobook.
            {"id": 10, "media_title": "Ten", "media_type": "book", "poster_url": "",
             "author": "one, author", "status": "available",
             "requested_date": "2026-09-01T00:00:00Z", "updated_date": "2026-09-01T00:00:00Z"},
        ])
        self.assertEqual([c for c in fake.calls if c[0] == "book"], [("book", {"bookIds": [20, 10]})])


def _books(n):
    return [{"id": i, "media_title": f"Book {i}", "media_type": "book",
             "requested_date": f"2026-09-{i:02d}T00:00:00Z"} for i in range(n, 0, -1)]


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class SharedCopyOfRecentBooks(unittest.TestCase):
    """integrations._recent_books: serve the shared copy, rebuild behind it."""

    def setUp(self):
        self.store = {}
        self.sets = []

        async def cache_get(key):
            return self.store.get(key)

        async def cache_set(key, value, ttl):
            self.sets.append((key, ttl))
            self.store[key] = value

        self.build = mock.AsyncMock(return_value=_books(50))
        patches = (mock.patch.object(integrations, "_cache_get", cache_get),
                   mock.patch.object(integrations, "_cache_set", cache_set),
                   mock.patch.object(integrations.chaptarr, "recent_requests", self.build),
                   mock.patch.object(integrations, "_recent_books_build", None))
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_a_fresh_copy_is_served_without_asking_chaptarr(self):
        self.store["recent-books"] = {"at": time.time(), "items": _books(50)}
        out = asyncio.run(integrations._recent_books(10))
        self.assertEqual(out, _books(50)[:10])
        self.build.assert_not_awaited()

    def test_an_old_copy_is_served_at_once_and_rebuilt_behind_it(self):
        old = _books(5)
        self.store["recent-books"] = {"at": time.time() - integrations._RECENT_BOOKS_FRESH - 1, "items": old}

        async def view():
            out = await integrations._recent_books(10)
            self.assertEqual(self.build.await_count, 0)   # nobody waited on Chaptarr
            await integrations._recent_books_build
            return out

        self.assertEqual(asyncio.run(view()), old)
        self.build.assert_awaited_once_with(limit=integrations._RECENT_BOOKS_MAX)
        self.assertEqual(self.store["recent-books"]["items"], _books(50))

    def test_no_copy_is_built_once_for_every_viewer_waiting(self):
        async def slow_build(limit):
            await asyncio.sleep(0.05)
            return _books(50)

        self.build.side_effect = slow_build

        async def three_viewers():
            return await asyncio.gather(integrations._recent_books(10),
                                        integrations._recent_books(50),
                                        integrations._recent_books(3))

        ten, fifty, three = asyncio.run(three_viewers())
        self.assertEqual((ten, fifty, three), (_books(50)[:10], _books(50), _books(50)[:3]))
        self.assertEqual(self.build.await_count, 1)
        self.assertEqual(self.sets, [("recent-books", integrations._RECENT_BOOKS_TTL)])

    def test_chaptarr_failing_leaves_the_panel_empty_not_broken(self):
        self.build.side_effect = httpx.ConnectError("refused")
        self.assertEqual(asyncio.run(integrations._recent_books(10)), [])


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class RecentRequestsEndpoint(unittest.TestCase):
    def setUp(self):
        setup_done = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        setup_done.start()
        self.addCleanup(setup_done.stop)
        self.client = helpers.api_client(helpers.make_sessionmaker(), user=helpers.MEMBER)
        self.addCleanup(helpers.reset_overrides)

    def test_films_live_and_books_from_the_copy_merged_newest_first(self):
        films = [{"id": 7, "media_title": "A Film", "media_type": "movie",
                  "requested_date": "2026-09-03T12:00:00Z"}]
        copy = {"at": time.time(), "items": _books(4)}
        with mock.patch.object(integrations.seerr, "get_recent_requests",
                               mock.AsyncMock(return_value=films)) as seerr_call, \
             mock.patch.object(integrations, "_cache_get", mock.AsyncMock(return_value=copy)), \
             mock.patch.object(integrations.chaptarr, "recent_requests",
                               mock.AsyncMock(side_effect=AssertionError("served from the copy"))):
            r = self.client.get("/api/integrations/recent-requests?limit=3")
        self.assertEqual(r.status_code, 200)
        self.assertEqual([row["media_title"] for row in r.json()], ["Book 4", "A Film", "Book 3"])
        seerr_call.assert_awaited_once_with(limit=3)


if __name__ == "__main__":
    unittest.main()
