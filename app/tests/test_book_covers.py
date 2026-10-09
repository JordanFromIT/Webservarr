"""
Book covers Open Library has no image for are not requested.

A Requests visit logged 10 to 25 failed image requests, one per book card
whose cover the proxy could not serve: Open Library answers some ids with a
redirect to archive.org (refused, M10) or a tiny placeholder. Such a miss is
now remembered (openlibrary.known_missing); the trending shelves, built in
the background, fetch each cover once and drop the ones that miss; search
results leave out the ones already known; and the proxy answers a first miss
with 204, which fails the <img> as before (its placeholder shows) without a
console error. A network failure is not a miss. Open Library is faked at the
httpx layer; nothing reaches it.
"""
import asyncio
import time
import unittest
from unittest import mock

import httpx

from app.integrations import openlibrary

try:
    from app.integrations import chaptarr
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

JPEG = b"\xff\xd8" + b"x" * 4000


def answers(table, seen):
    """A fake Open Library: cover id -> (status, content-type, body) or an exception."""
    def handler(request):
        cover = int(request.url.path.rsplit("/", 1)[1].split("-")[0])
        seen.append(cover)
        a = table[cover]
        if isinstance(a, Exception):
            raise a
        status, ctype, body = a
        headers = {"content-type": ctype}
        if status == 302:
            headers["location"] = f"https://archive.org/download/x/{cover}-M.jpg"
        return httpx.Response(status, headers=headers, content=body)
    real = httpx.AsyncClient

    def client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(*args, **kwargs)
    return mock.patch.object(openlibrary.httpx, "AsyncClient", client)


class CoverMisses(unittest.TestCase):
    def setUp(self):
        openlibrary._missing.clear()
        openlibrary._image_cache.clear()
        self.addCleanup(openlibrary._missing.clear)
        self.addCleanup(openlibrary._image_cache.clear)

    def test_open_library_misses_are_remembered_and_not_asked_again(self):
        seen = []
        table = {
            1: (302, "text/html", b""),           # a redirect to archive.org
            2: (200, "image/jpeg", b"\xff\xd8"),  # the tiny placeholder
            3: (200, "text/html", b"<html>" * 400),
            4: (404, "text/html", b""),
            5: (200, "image/jpeg", JPEG),
        }
        with answers(table, seen):
            for cover in (1, 2, 3, 4):
                self.assertIsNone(asyncio.run(openlibrary.fetch_cover(cover)))
                self.assertTrue(openlibrary.known_missing(cover), cover)
            self.assertEqual(asyncio.run(openlibrary.fetch_cover(5)), (JPEG, "image/jpeg"))
            self.assertFalse(openlibrary.known_missing(5))
            before = list(seen)
            for cover in (1, 2, 3, 4, 5):
                asyncio.run(openlibrary.fetch_cover(cover))
        self.assertEqual(seen, before, "a remembered miss or a cached cover is not fetched again")

    def test_a_network_failure_is_not_a_miss(self):
        seen = []
        with answers({7: httpx.ConnectTimeout("slow")}, seen):
            self.assertIsNone(asyncio.run(openlibrary.fetch_cover(7)))
        self.assertFalse(openlibrary.known_missing(7))

    def test_a_miss_is_forgotten_after_a_while(self):
        openlibrary._miss(9)
        self.assertTrue(openlibrary.known_missing(9))
        later = time.monotonic() + openlibrary._MISS_TTL + 1
        with mock.patch.object(openlibrary.time, "monotonic", return_value=later):
            self.assertFalse(openlibrary.known_missing(9))
        self.assertNotIn(9, openlibrary._missing)

    def test_the_misses_are_bounded(self):
        for i in range(openlibrary._MAX_CACHE + 50):
            openlibrary._miss(i)
        self.assertEqual(len(openlibrary._missing), openlibrary._MAX_CACHE)

    def test_missing_covers_names_only_what_open_library_lacks(self):
        seen = []
        table = {1: (302, "text/html", b""), 5: (200, "image/jpeg", JPEG), 7: httpx.ConnectTimeout("slow")}
        with answers(table, seen):
            got = asyncio.run(openlibrary.missing_covers([1, 5, 7, 1, None, "x"]))
        self.assertEqual(got, {1})
        self.assertEqual(sorted(seen), [1, 5, 7], "each id fetched once, junk ignored")
        self.assertIn(5, openlibrary._image_cache, "the good cover is cached for the visit")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class CoverUrls(unittest.TestCase):
    def setUp(self):
        openlibrary._missing.clear()
        self.addCleanup(openlibrary._missing.clear)

    def test_a_known_miss_is_never_offered(self):
        openlibrary._miss(11)
        self.assertIsNone(chaptarr._cover_url(11))
        self.assertIsNone(chaptarr._cover_url(None))
        self.assertEqual(chaptarr._cover_url(12), "/api/integrations/book-cover?coverId=12")

    def test_search_results_leave_out_known_misses(self):
        openlibrary._miss(11)
        items = [{"title": "Gone", "author": "A"}, {"title": "Here", "author": "B"}, {"title": "Own", "poster_url": "/x.jpg"}]

        async def ids(books, budget=None):
            return {("Gone", "A"): 11, ("Here", "B"): 12}
        with mock.patch.object(chaptarr.openlibrary, "cover_ids", ids):
            asyncio.run(chaptarr._attach_covers(items))
        self.assertFalse(items[0].get("poster_url"))
        self.assertEqual(items[1]["poster_url"], "/api/integrations/book-cover?coverId=12")
        self.assertEqual(items[2]["poster_url"], "/x.jpg")

    def test_a_shelf_drops_the_covers_open_library_lacks(self):
        cards = [{"id": "a", "poster_url": "/api/integrations/book-cover?coverId=21"},
                 {"id": "b", "poster_url": "/api/integrations/book-cover?coverId=22"},
                 {"id": "c", "poster_url": None}]
        asked = []

        async def missing(ids, budget=None):
            asked.append(sorted(ids))
            return {21}
        with mock.patch.object(chaptarr.openlibrary, "missing_covers", missing):
            asyncio.run(chaptarr._drop_missing_covers(cards, budget=5))
        self.assertEqual(asked, [[21, 22]])
        self.assertIsNone(cards[0]["poster_url"])
        self.assertEqual(cards[1]["poster_url"], "/api/integrations/book-cover?coverId=22")

    def test_the_shelf_build_checks_its_covers(self):
        src = (chaptarr.__file__)
        with open(src, encoding="utf-8") as f:
            code = f.read()
        tail = code[code.index("async def resolve_trending"):code.index("async def _lookup_book")]
        self.assertIn("await _drop_missing_covers(cards, budget=openlibrary.TRENDING_COVER_BUDGET)", tail)

    def test_the_proxy_answers_a_miss_with_204(self):
        Session = helpers.make_sessionmaker()
        client = helpers.api_client(Session, user=helpers.MEMBER, headers=helpers.SAME_ORIGIN)
        self.addCleanup(helpers.reset_overrides)

        async def none(cover_id):
            return None

        async def jpeg(cover_id):
            return (JPEG, "image/jpeg")
        with mock.patch.object(openlibrary, "fetch_cover", none):
            r = client.get("/api/integrations/book-cover", params={"coverId": 31})
        self.assertEqual(r.status_code, 204)
        self.assertEqual(r.content, b"")
        with mock.patch.object(openlibrary, "fetch_cover", jpeg):
            r = client.get("/api/integrations/book-cover", params={"coverId": 32})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-type"], "image/jpeg")


if __name__ == "__main__":
    unittest.main()
