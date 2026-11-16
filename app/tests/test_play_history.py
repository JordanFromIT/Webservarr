"""
Play history (app/services/play_history.py, app/routers/play_history.py and
kavita.reading_sessions).

The session grouping and cursor paging run on a real in-memory database;
Kavita is stubbed at the httpx layer, and the caller's reach (books.scope_of,
which asks Plex and Kavita) at its function boundary. No test reaches Plex,
Kavita, Redis or the dev instance's settings.
"""
import asyncio
import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from app.tests import helpers

try:
    import httpx
    from app.integrations import kavita
    from app.models import Book, BookAudioEdition, ListeningLog
    from app.routers import play_history as route
    from app.routers.books import Scope
    from app.services import play_history as ph
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

KAVITA = "https://kavita.example"


def now():
    return datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)


def log(db, identity, book, at, ms, event="checkin", device="Chrome on Android", device_id="d" * 16,
        track="t1", label="Chapter 3", duration=3_600_000):
    db.add(ListeningLog(identity=identity, book_key=book, track_key=track, offset_ms=ms, device=device,
                        device_id=device_id, event=event, at=at, book_ms=ms, book_duration_ms=duration,
                        chapter_label=label, source="web"))


def sitting(db, identity, book, end, minutes, start_ms=0, step_s=10, **kw):
    """Check-ins every step_s seconds for `minutes`, ending at `end`."""
    count = int(minutes * 60 / step_s)
    for i in range(count + 1):
        at = end - timedelta(seconds=step_s * (count - i))
        log(db, identity, book, at, start_ms + i * step_s * 1000, event="play" if i == 0 else "checkin", **kw)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Grouping(unittest.TestCase):
    T = datetime(2026, 11, 15, 12, 0, 0)

    def rows(self, spec):
        """spec: (seconds before T, book, device_id, event), given newest first."""
        out = []
        for i, (ago, book, dev, event) in enumerate(spec):
            out.append((1000 - i, book, "t1", ago, "Phone", dev, event, self.T - timedelta(seconds=ago),
                        100_000 - ago * 1000, 3_600_000, "Chapter 1"))
        return out

    def test_gap_over_ten_minutes_starts_a_new_session(self):
        s = ph.group_rows(self.rows([(0, "1:1", "a", "checkin"), (601, "1:1", "a", "checkin")]))
        self.assertEqual(len(s), 2)

    def test_exactly_ten_minutes_is_the_same_session(self):
        s = ph.group_rows(self.rows([(0, "1:1", "a", "checkin"), (600, "1:1", "a", "play")]))
        self.assertEqual(len(s), 1)
        self.assertEqual(s[0].rows, 2)

    def test_another_device_starts_a_new_session(self):
        s = ph.group_rows(self.rows([(0, "1:1", "a", "checkin"), (10, "1:1", "b", "checkin")]))
        self.assertEqual([x.who for x in s], ["id:a", "id:b"])

    def test_another_book_between_does_not_split_a_sitting(self):
        # The per-book history panel sees only one book's rows: the same here.
        s = ph.group_rows(self.rows([(0, "1:1", "a", "checkin"), (10, "2:1", "a", "checkin"),
                                     (20, "1:1", "a", "checkin")]))
        self.assertEqual([x.book_key for x in s], ["1:1", "2:1"])
        self.assertEqual(s[0].rows, 2)

    def test_listened_counts_short_gaps_from_playing_rows_only(self):
        s = ph.group_rows(self.rows([(0, "1:1", "a", "checkin"), (10, "1:1", "a", "checkin"),
                                     (20, "1:1", "a", "pause"), (300, "1:1", "a", "play")]))
        # 10 s (checkin -> checkin); the pause's 10 s gap does not count (not
        # a playing row), and the play row's 280 s gap is over 30 s.
        self.assertEqual(s[0].listened_ms, 10_000)

    def test_end_and_start_places(self):
        s = ph.group_rows(self.rows([(0, "1:1", "a", "checkin"), (10, "1:1", "a", "checkin")]))[0]
        self.assertEqual(s.end_book_ms, 100_000)
        self.assertEqual(s.start_book_ms, 90_000)
        self.assertEqual(s.end_id, 1000)

    def test_keys_filter_rows(self):
        s = ph.group_rows(self.rows([(0, "1:1", "a", "checkin"), (10, "2:1", "a", "checkin")]), keys={"2:1"})
        self.assertEqual([x.book_key for x in s], ["2:1"])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Cursor(unittest.TestCase):
    def test_round_trip(self):
        key = (datetime(2026, 11, 15, 1, 2, 3, 456789), ph.RANK["a"], 42, 0)
        self.assertEqual(ph.parse_cursor(ph.make_cursor(key)), key)
        key = (datetime(2026, 11, 15, 1, 2, 3), ph.RANK["e"], 7, 9)
        self.assertEqual(ph.parse_cursor(ph.make_cursor(key)), key)

    def test_rejects_junk(self):
        for bad in ("", "2026-11-15", "2026-11-15T01:02:03Z", "2026-11-15T01:02:03Z~x1", "x" * 64, None):
            with self.assertRaises(ValueError):
                ph.parse_cursor(bad)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class AudioPaging(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.addCleanup(self.db.close)

    def pages(self, limit, keys=None):
        out, before = [], None
        for _ in range(50):
            got, more = ph.audio_sessions(self.db, "plex:1", keys or {"1:1", "2:1"}, before, limit)
            out.append(got)
            if not more:
                return out
            before = got[-1].key
        self.fail("paging never ended")

    def test_every_session_once_across_pages(self):
        t = now()
        sitting(self.db, "plex:1", "1:1", t - timedelta(hours=1), 30)
        sitting(self.db, "plex:1", "2:1", t - timedelta(hours=3), 20)
        sitting(self.db, "plex:1", "1:1", t - timedelta(hours=5), 25)
        sitting(self.db, "plex:2", "1:1", t - timedelta(minutes=2), 10)   # someone else's
        self.db.commit()
        for limit in (1, 2, 3, 5):
            for batch in (7, 2000):
                with self.subTest(limit=limit, batch=batch), mock.patch.object(ph, "BATCH", batch):
                    flat = [s for p in self.pages(limit) for s in p]
                    self.assertEqual([s.book_key for s in flat], ["1:1", "2:1", "1:1"])
                    self.assertEqual([s.rows for s in flat], [181, 121, 151])
                    self.assertTrue(all(len(p) <= limit for p in self.pages(limit)))

    def test_a_long_session_is_never_split_by_the_cursor(self):
        t = now()
        # Book 1 runs across book 2's sitting, which ends inside it: the
        # page break after book 2 must not cut book 1 in two.
        sitting(self.db, "plex:1", "1:1", t, 60)
        sitting(self.db, "plex:1", "2:1", t - timedelta(minutes=50), 5, device_id="e" * 16)
        sitting(self.db, "plex:1", "2:1", t - timedelta(minutes=30), 5, device_id="e" * 16)
        self.db.commit()
        with mock.patch.object(ph, "BATCH", 5):
            flat = [s for p in self.pages(1) for s in p]
        self.assertEqual([(s.book_key, s.rows) for s in flat], [("1:1", 361), ("2:1", 31), ("2:1", 31)])

    def test_books_the_caller_cannot_see_are_left_out(self):
        t = now()
        sitting(self.db, "plex:1", "1:1", t, 5)
        sitting(self.db, "plex:1", "9:1", t - timedelta(hours=1), 5)
        self.db.commit()
        got, more = ph.audio_sessions(self.db, "plex:1", {"1:1"}, None, 10)
        self.assertEqual([s.book_key for s in got], ["1:1"])
        self.assertFalse(more)


def ebook_row(session, chapter, end, minutes=20, start_page=10, end_page=30, pages=300):
    return {"session_id": session, "chapter_id": chapter, "series_id": 5, "start": end - timedelta(minutes=minutes),
            "end": end, "start_page": start_page, "end_page": end_page, "pages": pages, "seconds": minutes * 60}


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class EbooksAndMerge(unittest.TestCase):
    def test_only_visible_chapters_newest_first(self):
        t = now()
        rows = [ebook_row(1, 70, t - timedelta(hours=2)), ebook_row(2, 71, t), ebook_row(3, 99, t)]
        got, more, _ = ph.ebook_page(rows, {70: 1, 71: 1}, None, 10, True)
        self.assertEqual([s.session_id for s in got], [2, 1])
        self.assertFalse(more)

    def test_before_and_limit(self):
        t = now()
        rows = [ebook_row(i, 70, t - timedelta(hours=i)) for i in range(1, 6)]
        got, more, _ = ph.ebook_page(rows, {70: 1}, None, 2, True)
        self.assertEqual([s.session_id for s in got], [1, 2])
        self.assertTrue(more)
        got, more, _ = ph.ebook_page(rows, {70: 1}, got[-1].key, 2, True)
        self.assertEqual([s.session_id for s in got], [3, 4])

    def test_merge_never_skips_a_kind_that_has_more(self):
        t = now()
        a = [mock.Mock(key=(t - timedelta(hours=h), 1, h, 0)) for h in (1, 2)]
        e = [mock.Mock(key=(t - timedelta(hours=h), 0, h, 0)) for h in (3, 4)]
        page = ph.merge(a, True, e, False, 3)
        # Audio stopped at hour 2 with more to give: the page ends there, so
        # the next page reads audio past hour 2 before ebooks at hours 3 and 4.
        self.assertEqual(page.items, a)
        self.assertEqual(page.next_key, a[-1].key)

    def test_merge_interleaves_and_ends(self):
        t = now()
        a = [mock.Mock(key=(t - timedelta(hours=1), 1, 1, 0))]
        e = [mock.Mock(key=(t - timedelta(minutes=30), 0, 2, 0))]
        page = ph.merge(a, False, e, False, 5)
        self.assertEqual(page.items, [e[0], a[0]])
        self.assertIsNone(page.next_key)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class KavitaSessions(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.real_client = httpx.AsyncClient
        p = mock.patch.object(kavita.httpx, "AsyncClient", self.client)
        p.start()
        self.addCleanup(p.stop)
        self.history = []

    def client(self, **kwargs):
        return self.real_client(transport=httpx.MockTransport(self.handle))

    def handle(self, request):
        self.requests.append(request)
        if request.url.path == "/api/Library/libraries":
            return httpx.Response(200, json=[{"id": 1, "type": 2}, {"id": 4, "type": 2}])
        if request.url.path == "/api/Stats/reading-history":
            n = int(request.url.params["PageNumber"])
            page = self.history[n - 1] if n <= len(self.history) else []
            return httpx.Response(200, json=page, headers={"pagination": json.dumps({"totalPages": len(self.history)})})
        return httpx.Response(404)

    def item(self, session, chapter, generated=False):
        return {"sessionId": session, "isGeneratedSession": generated, "seriesId": 5,
                "startTimeUtc": "2026-11-14T20:00:00.1234567", "endTimeUtc": "2026-11-14T20:38:00.7654321Z",
                "chapters": [{"chapterId": chapter, "startTimeUtc": "2026-11-14T20:00:00.1234567",
                              "endTimeUtc": "2026-11-14T20:38:00.7654321Z", "startPage": 120, "endPage": 142,
                              "totalPages": 600, "durationSeconds": 2280}]}

    def test_reads_the_persons_own_sessions_by_their_libraries(self):
        self.history = [[self.item(1, 70), self.item(2, 71, generated=True)]]
        rows, complete = asyncio.run(kavita.reading_sessions(KAVITA, "TOKEN", datetime(2026, 5, 1),
                                                             datetime(2026, 11, 15, 1, 2, 3)))
        self.assertTrue(complete)
        self.assertEqual(len(rows), 1)       # the generated (estimated) session is left out
        r = rows[0]
        self.assertEqual((r["session_id"], r["chapter_id"], r["start_page"], r["end_page"], r["pages"]),
                         (1, 70, 120, 142, 600))
        self.assertEqual(r["end"], datetime(2026, 11, 14, 20, 38, 0, 765432))
        q = self.requests[-1].url.params
        self.assertEqual(q.get_list("Libraries"), ["1", "4"])
        self.assertEqual(q["StartDate"], "2026-05-01T00:00:00Z")
        self.assertTrue(q["EndDate"].startswith("2026-11-15T01:02:03"))
        self.assertEqual(self.requests[-1].headers["Authorization"], "Bearer TOKEN")

    def test_stops_once_enough_rows(self):
        self.history = [[self.item(i, 70) for i in range(3)], [self.item(9, 70)]]
        rows, complete = asyncio.run(kavita.reading_sessions(KAVITA, "TOKEN", datetime(2026, 5, 1), enough=2))
        self.assertFalse(complete)
        self.assertEqual(len(rows), 3)

    def test_stamp_parsing(self):
        self.assertEqual(kavita._utc_stamp("2026-11-14T20:38:00Z"), datetime(2026, 11, 14, 20, 38))
        self.assertEqual(kavita._utc_stamp("2026-11-14T20:38:00.1+00:00"), datetime(2026, 11, 14, 20, 38, 0, 100000))
        for bad in (None, "", "yesterday", 5):
            self.assertIsNone(kavita._utc_stamp(bad))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Endpoint(unittest.TestCase):
    A = {"user_id": "1001", "username": "a", "is_admin": "false", "auth_method": "plex",
         "plex_account_id": "1001", "email": ""}

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        db = self.Session()
        t = now()
        db.add(Book(id=1, title="Audio Book", author="Ann", sort_title="Audio Book", updated_at=t,
                    plex_book_key="100:1"))
        db.add(BookAudioEdition(book_id=1, plex_book_key="100:1"))
        db.add(Book(id=2, title="Read Book", author="Bea", sort_title="Read Book", updated_at=t,
                    kavita_chapter_id=70, kavita_series_id=5))
        db.add(Book(id=3, title="Hidden Book", author="Cy", sort_title="Hidden Book", updated_at=t,
                    plex_book_key="300:1"))
        db.add(BookAudioEdition(book_id=3, plex_book_key="300:1"))
        sitting(db, "plex:1001", "100:1", t - timedelta(hours=1), 24, start_ms=1_000_000)
        sitting(db, "plex:1002", "100:1", t - timedelta(minutes=5), 10)       # another listener
        db.commit()
        db.close()
        self.scope = Scope(identity="plex:1001", series={5}, kavita=(KAVITA, "TOKEN"), audio=True)
        self.sessions = ([], True)

        async def fake_scope(user, session_id):
            return self.scope

        async def fake_sessions(base, token, since, until=None, enough=50):
            if isinstance(self.sessions, Exception):
                raise self.sessions
            return self.sessions

        async def fake_number(base, token, chapter_id, page):
            return 12

        for p in (mock.patch.object(route, "scope_of", fake_scope),
                  mock.patch.object(route.kavita, "reading_sessions", fake_sessions),
                  mock.patch.object(route.kavita, "chapter_number_at", fake_number)):
            p.start()
            self.addCleanup(p.stop)
        self.client = helpers.api_client(self.Session, user=self.A)
        self.addCleanup(helpers.reset_overrides)

    def test_own_listening_only(self):
        r = self.client.get("/api/me/history?kind=audio")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(len(body["items"]), 1)
        item = body["items"][0]
        self.assertEqual((item["kind"], item["book_id"], item["title"], item["book_url"]),
                         ("audio", 1, "Audio Book", "/books/1"))
        self.assertEqual(item["from_ms"], 1_000_000)
        self.assertEqual(item["to_ms"], 1_000_000 + 24 * 60 * 1000)
        self.assertEqual(item["place"], {"track": "t1", "offset_ms": 1_000_000 + 24 * 60 * 1000})
        self.assertEqual(item["listened_ms"], 24 * 60 * 1000)
        self.assertTrue(item["end"].endswith("Z"))
        self.assertIsNone(body["next_before"])

    def test_identity_comes_from_the_session(self):
        self.scope = Scope(identity="plex:1002", series=set(), kavita=None, audio=True)
        items = self.client.get("/api/me/history").json()["items"]
        self.assertEqual([i["listened_ms"] for i in items], [10 * 60 * 1000])

    def test_ebook_sessions_with_reader_link(self):
        t = now()
        self.sessions = ([ebook_row(8, 70, t - timedelta(minutes=10), start_page=120, end_page=142, pages=600),
                          ebook_row(9, 99, t)], True)
        body = self.client.get("/api/me/history?kind=ebook").json()
        self.assertEqual(len(body["items"]), 1)
        item = body["items"][0]
        self.assertEqual((item["kind"], item["book_id"], item["chapter"], item["start_page"], item["end_page"],
                          item["pages"]), ("ebook", 2, 12, 121, 143, 600))
        self.assertEqual(item["read_url"], "/reader?seriesId=5&chapterId=70&page=143")

    def test_all_merges_newest_first_and_pages(self):
        t = now()
        self.sessions = ([ebook_row(8, 70, t - timedelta(minutes=10))], True)
        body = self.client.get("/api/me/history?limit=1").json()
        self.assertEqual([i["kind"] for i in body["items"]], ["ebook"])
        self.assertIsNotNone(body["next_before"])
        nxt = self.client.get("/api/me/history", params={"limit": 1, "before": body["next_before"]}).json()
        self.assertEqual([i["kind"] for i in nxt["items"]], ["audio"])
        self.assertIsNone(nxt["next_before"])

    def test_kavita_down_keeps_listening_with_a_note(self):
        self.sessions = kavita.KavitaUnavailable("down")
        body = self.client.get("/api/me/history").json()
        self.assertEqual([i["kind"] for i in body["items"]], ["audio"])
        self.assertEqual(body["notes"][0]["reason"], "unavailable")

    def test_503_when_nothing_asked_for_could_be_read(self):
        self.sessions = kavita.KavitaUnavailable("down")
        r = self.client.get("/api/me/history?kind=ebook")
        self.assertEqual(r.status_code, 503)

    def test_not_connected_is_empty_not_an_error(self):
        self.sessions = kavita.KavitaTokenRefused("expired")
        r = self.client.get("/api/me/history?kind=ebook")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["items"], [])
        self.assertEqual(r.json()["notes"][0]["reason"], "not_connected")

    def test_no_audio_access_shows_no_listening(self):
        self.scope = Scope(identity="plex:1001", series=set(), kavita=None, audio=False)
        r = self.client.get("/api/me/history")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["items"], [])

    def test_bad_input_is_422(self):
        for q in ("kind=films", "limit=0", "limit=51", "before=nonsense"):
            with self.subTest(q=q):
                self.assertEqual(self.client.get("/api/me/history?" + q).status_code, 422)

    def test_rate_limited_per_session(self):
        from app.limiter import limiter
        from app.routers.player import session_rate_key
        name = f"{route.history.__module__}.{route.history.__name__}"
        self.assertEqual([(str(lim.limit), lim.key_func, lim.scope) for lim in limiter._route_limits[name]],
                         [("60 per 1 minute", session_rate_key, "me:history")])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ShellEntry(unittest.TestCase):
    """The account menu's and More's Play history entry goes with Books."""

    def values(self, branding):
        from app import pages
        return pages.shell_values(branding, {"username": "sam", "is_admin": False}, "", "index")

    def test_shown_while_books_is(self):
        self.assertEqual(self.values({"features": {"books_configured": True}})["history_cls"], "")

    def test_hidden_without_books_or_when_switched_off(self):
        self.assertEqual(self.values({"features": {}})["history_cls"], "hidden")
        self.assertEqual(self.values({"features": {"books_configured": True},
                                      "sidebar_enabled": {"library": False}})["history_cls"], "hidden")

    def test_both_entries_carry_the_switch(self):
        from app.tests.test_shell_contract import STATIC
        head = (STATIC / "partials" / "shell-header.html").read_text(encoding="utf-8")
        side = (STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8")
        self.assertRegex(head, r'<button type="button" data-play-history class="[^"]*\{\{history_cls\}\}')
        self.assertRegex(side, r'<li class="\{\{history_cls\}\}">\s*<button type="button" class="ws-sheet-row" data-play-history>')
        self.assertIn('id="wsHistory"', side)
        self.assertIn('src="/static/js/play-history.js?v=1"', side)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class HiddenReadingNeverSkipped(unittest.TestCase):
    """Kavita's newest sessions all in chapters the caller can't see (another
    chapter of a numbered volume, a book not in the catalog): the visible
    session further back is still listed, under All and under eBooks."""
    A = Endpoint.A

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        db = self.Session()
        t = now()
        db.add(Book(id=1, title="Audio Book", author="Ann", sort_title="Audio Book", updated_at=t, plex_book_key="100:1"))
        db.add(BookAudioEdition(book_id=1, plex_book_key="100:1"))
        db.add(Book(id=2, title="Read Book", author="Bea", sort_title="Read Book", updated_at=t,
                    kavita_chapter_id=70, kavita_series_id=5))
        for h in range(1, 26):
            sitting(db, "plex:1001", "100:1", t - timedelta(hours=h), 2)
        db.commit()
        db.close()
        self.kavita = [ebook_row(1000 + i, 99, t - timedelta(minutes=10 * i), minutes=5) for i in range(60)]
        self.kavita.append(ebook_row(7, 70, t - timedelta(hours=15), minutes=5))
        scope = Scope(identity="plex:1001", series={5}, kavita=(KAVITA, "TOKEN"), audio=True)

        async def fake_scope(user, session_id):
            return scope

        async def fake_sessions(base, token, since, until=None, enough=50):
            # kavita.reading_sessions' contract: newest start first, 50 a page,
            # stop once `enough` rows are in hand.
            rows = sorted((r for r in self.kavita if r["end"] >= since and (until is None or r["end"] <= until)),
                          key=lambda r: r["start"], reverse=True)
            out = []
            for i in range(0, len(rows), 50):
                out += rows[i:i + 50]
                if i + 50 >= len(rows):
                    return out, True
                if len(out) >= enough:
                    return out, False
            return out, True

        async def fake_number(base, token, chapter_id, page):
            return None

        for p in (mock.patch.object(route, "scope_of", fake_scope),
                  mock.patch.object(route.kavita, "reading_sessions", fake_sessions),
                  mock.patch.object(route.kavita, "chapter_number_at", fake_number)):
            p.start()
            self.addCleanup(p.stop)
        self.client = helpers.api_client(self.Session, user=self.A)
        self.addCleanup(helpers.reset_overrides)

    def every_page(self, kind):
        seen, before = [], None
        for _ in range(20):
            params = {"kind": kind, "limit": 20}
            if before:
                params["before"] = before
            body = self.client.get("/api/me/history", params=params).json()
            seen.append([i["id"] for i in body["items"]])
            before = body["next_before"]
            if not before:
                return seen
        self.fail("paging never ended")

    def test_all_lists_the_visible_session_and_every_listen_once(self):
        flat = [i for page in self.every_page("all") for i in page]
        self.assertIn("e7.70", flat)
        self.assertEqual(sum(1 for i in flat if i.startswith("a")), 25)
        self.assertEqual(len(flat), len(set(flat)))

    def test_ebooks_first_page_is_never_empty_with_more_behind_it(self):
        pages = self.every_page("ebook")
        self.assertEqual(pages[0], ["e7.70"])

    def test_merge_stops_where_reading_stopped(self):
        t = now()
        a = [mock.Mock(key=(t - timedelta(hours=h), 1, h, 0)) for h in (1, 2, 3)]
        resume = (t - timedelta(minutes=150), 0, ph.RESUME_ID, 0)
        page = ph.merge(a, True, [], True, 3, resume)
        self.assertEqual(page.items, a[:2])
        self.assertEqual(page.next_key, resume)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class FarCursor(unittest.TestCase):
    def test_a_cursor_past_the_last_time_is_refused(self):
        with self.assertRaises(ValueError):
            ph.parse_cursor("9999-12-31T23:55:00Z~a1")
        self.assertEqual(ph.parse_cursor("9999-12-31T23:40:00Z~a1")[0], datetime(9999, 12, 31, 23, 40))

    def test_the_route_answers_422(self):
        Session = helpers.make_sessionmaker()
        client = helpers.api_client(Session, user=Endpoint.A)
        self.addCleanup(helpers.reset_overrides)

        async def fake_scope(user, session_id):
            return Scope(identity="plex:1001", series=set(), kavita=None, audio=True)

        with mock.patch.object(route, "scope_of", fake_scope):
            r = client.get("/api/me/history", params={"before": "9999-12-31T23:55:00Z~a1"})
        self.assertEqual(r.status_code, 422)
