"""
Insights, Trends, Books, one book and Habits (docs/superpowers/specs/2026-10-10-insights-design.md,
sections 3, 6 and 7): buckets and weeks in the viewer's zone, the web play
counted once, abandoned, never opened, finish rate and drop-off, the split,
the heatmap, requested then read, and an empty install.
"""
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest import mock

try:
    from app.tests import helpers
    from app.tests.test_insights_api import ME, NOW, THEM, Base
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False
    Base = unittest.TestCase
if HAVE_APP:
    from app.models import BookRequester, ReadingTotal
    from app.services import insights


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Trends(Base):
    def test_buckets_people_and_tops(self):
        self.book(1, "Dune", keys=["5:1"], author="Frank Herbert", series="Dune")
        self.book(2, "Emma", keys=["6:1"], author="Jane Austen")
        self.hour(ME, "5:1", datetime(2026, 10, 9, 20), 3600000)
        self.hour(THEM, "5:1", datetime(2026, 10, 2, 20), 1800000)
        self.hour(THEM, "6:1", datetime(2026, 10, 2, 21), 600000)
        self.add(ReadingTotal(identity=ME, day=date(2026, 10, 1), pages=100, seen_at=NOW),
                 ReadingTotal(identity=ME, day=date(2026, 10, 9), pages=160, seen_at=NOW))
        plays = [insights.Play(THEM, "6:1", datetime(2026, 10, 9, 8), 900000)]
        got = insights.trends_view(self.db, self.src(plays=plays), "30d", timezone.utc)
        self.assertEqual(got["bucket"], "day")
        self.assertEqual(len(got["buckets"]), 31)                         # 10 Sep to 10 Oct
        by_day = {b["start"]: b for b in got["buckets"]}
        self.assertEqual((by_day["2026-10-09"]["web_ms"], by_day["2026-10-09"]["plex_ms"],
                          by_day["2026-10-09"]["pages"]), (3600000, 900000, 60))
        self.assertEqual(by_day["2026-10-01"]["pages"], 0)
        self.assertEqual([(a["week"], a["people"]) for a in got["active"]][-2:],
                         [("2026-09-28", 1), ("2026-10-05", 2)])
        self.assertEqual([(b["title"], b["listened_ms"], b["people"]) for b in got["top_books"]],
                         [("Dune", 5400000, 2), ("Emma", 1500000, 1)])
        self.assertEqual([(a["name"], a["people"]) for a in got["top_authors"]],
                         [("Frank Herbert", 2), ("Jane Austen", 1)])
        self.assertEqual([s["name"] for s in got["top_series"]], ["Dune"])

    def test_trends_count_a_web_play_once(self):
        self.book(1, "Dune", keys=["5:1"])
        self.hour(ME, "5:1", datetime(2026, 10, 9, 20), 1200000)
        web = insights.listens(self.db)
        raw = [insights.Play(ME, "5:1", datetime(2026, 10, 9, 20, 25), 1200000)]
        src = insights.Sources(listens=web, plays=insights.app_plays(raw, web), names={}, now=NOW)
        got = insights.trends_view(self.db, src, "30d", timezone.utc)
        self.assertEqual(sum(b["web_ms"] + b["plex_ms"] for b in got["buckets"]), 1200000)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Zones(Base):
    def test_days_and_hours_are_the_viewers(self):
        from zoneinfo import ZoneInfo
        self.book(1, "Dune", keys=["5:1"])
        self.hour(ME, "5:1", datetime(2026, 10, 9, 18), 600000)      # 23:30 on Friday in Kolkata
        self.hour(ME, "5:1", datetime(2026, 10, 10, 3), 600000)      # 08:30 on Saturday there; 20:00 Friday in Los Angeles
        heat = insights.habits_view(self.db, self.src(plays=[]), "30d", ZoneInfo("Asia/Kolkata"))["heatmap"]
        self.assertEqual((heat[4][23], heat[5][8]), (600000, 600000))
        trends = insights.trends_view(self.db, self.src(plays=[]), "30d", ZoneInfo("America/Los_Angeles"))
        by_day = {b["start"]: b["web_ms"] for b in trends["buckets"]}
        self.assertEqual((by_day["2026-10-09"], by_day["2026-10-10"]), (1200000, 0))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Books(Base):
    def test_abandoned_never_opened_and_finish_rate(self):
        self.book(1, "Dune", keys=["5:1"])
        self.book(2, "Emma", keys=["6:1"])
        self.book(3, "Ulysses", keys=["7:1"], added=datetime(2026, 9, 1))
        self.book(4, "Walden", added=datetime(2026, 10, 1), chapter=41)
        old = NOW - timedelta(days=40)
        self.place(ME, "5:1", NOW - timedelta(days=2), ms=36000000, event="end")
        self.place(THEM, "5:1", old, ms=1800000, chapter="Chapter 7")
        self.place("plex:3003", "5:1", old - timedelta(hours=1), ms=2400000, chapter="Chapter 7")
        self.place(ME, "6:1", old, ms=60000)                                      # a mis-tap, not a start
        got = insights.books_view(self.db, self.src(plays=[], names={"1001": "Sam"}), "all")
        self.assertEqual([(a["name"], a["title"], a["chapter"]) for a in got["abandoned"]],
                         [("Account 2002", "Dune", "Chapter 7"), ("Account 3003", "Dune", "Chapter 7")])
        self.assertEqual(got["never_opened"]["count"], 2)
        self.assertEqual([b["title"] for b in got["never_opened"]["items"]], ["Walden", "Ulysses"])
        self.assertEqual(got["finish"], [{"book_id": 1, "title": "Dune", "author": "An Author", "started": 3,
                                          "started_plex": 0, "finished": 1, "rate": 33,
                                          "drop_off": {"chapter": "Chapter 7", "people": 2}}])

    def test_plex_app_listening_starts_a_book_in_the_period(self):
        self.book(1, "Dune", keys=["5:1", "5:2"])
        self.place(ME, "5:1", NOW - timedelta(days=2), ms=1200000)
        plays = [insights.Play(THEM, "5:1", NOW - timedelta(days=3), 180000),       # two tracks, two editions:
                 insights.Play(THEM, "5:2", NOW - timedelta(days=3), 180000),       # 6 min in all, a start
                 insights.Play(ME, "5:1", NOW - timedelta(days=2), 3600000),        # already started on the web
                 insights.Play("plex:3003", "5:1", NOW - timedelta(days=3), 240000),     # 4 min, a mis-tap
                 insights.Play("plex:4004", "5:1", NOW - timedelta(days=60), 3600000)]   # before the period
        got = insights.books_view(self.db, self.src(plays=plays), "30d")
        self.assertEqual([(f["title"], f["started"], f["started_plex"], f["finished"], f["rate"])
                          for f in got["finish"]], [("Dune", 2, 1, 0, 0)])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class BookDetail(Base):
    def test_everyone_in_one_book(self):
        self.book(1, "Dune", keys=["5:1", "5:2"])
        self.place(ME, "5:1", NOW - timedelta(days=1), ms=18000000)
        self.place(THEM, "5:2", NOW - timedelta(days=40), ms=900000, chapter="Chapter 2")
        self.hour(ME, "5:1", datetime(2026, 10, 9, 20), 3600000)
        self.add(BookRequester(identity=THEM, foreign_id="gr:1", title="DUNE", format="audiobook",
                               requested_at=datetime(2026, 9, 1)))
        got = insights.book_view(self.db, self.src(plays=[], names={"1001": "Sam"}), 1)
        self.assertEqual([(p["name"], p["percent"], p["listened_ms"]) for p in got["people"]],
                         [("Sam", 50, 3600000), ("Account 2002", 2, 0)])
        self.assertEqual(got["totals"], {"started": 2, "started_plex": 0, "finished": 0, "rate": 0,
                                         "listened_ms": 3600000, "plex_ms": 0})
        self.assertIsNone(got["drop_off"])                       # one person is not a drop-off point
        self.assertEqual([r["name"] for r in got["requested_by"]], ["Account 2002"])
        self.assertIsNone(insights.book_view(self.db, self.src(plays=[]), 99))

    def test_plex_app_listening_counts_as_a_start(self):
        self.book(1, "Dune", keys=["5:1"])
        self.place(ME, "5:1", NOW - timedelta(days=1), ms=60000)                 # a mis-tap, not a start
        plays = [insights.Play(THEM, "5:1", NOW - timedelta(days=5, hours=n), 3600000) for n in range(80)]
        plays.append(insights.Play(ME, "5:1", NOW - timedelta(days=1), 120000))  # 2 min: still a mis-tap
        got = insights.book_view(self.db, self.src(plays=plays), 1)
        self.assertEqual(got["totals"], {"started": 1, "started_plex": 1, "finished": 0, "rate": 0,
                                         "listened_ms": 0, "plex_ms": 80 * 3600000 + 120000})


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Habits(Base):
    def test_split_heatmap_and_requested_then_read(self):
        self.book(1, "Dune", keys=["5:1"])
        self.hour(ME, "5:1", datetime(2026, 10, 9, 20), 3600000)
        plays = [insights.Play(THEM, "5:1", datetime(2026, 10, 8, 7, 15), 600000)]
        self.add(BookRequester(identity=ME, foreign_id="gr:1", title="Dune", format="both",
                               requested_at=datetime(2026, 10, 1)),
                 BookRequester(identity=THEM, foreign_id="gr:2", title="Not Here Yet", format="ebook",
                               requested_at=datetime(2026, 10, 2)))
        got = insights.habits_view(self.db, self.src(plays=plays), "30d", timezone.utc)
        self.assertEqual(got["split"], {"web_ms": 3600000, "plex_ms": 600000})
        self.assertEqual((got["heatmap"][4][20], got["heatmap"][3][7]), (3600000, 600000))
        self.assertEqual((got["requested"]["total"], got["requested"]["read"]), (2, 1))
        self.assertEqual([(i["title"], i["book_id"]) for i in got["requested"]["items"]],
                         [("Not Here Yet", None), ("Dune", 1)])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class EmptyInstall(Base):
    def test_every_view_answers_on_an_empty_database(self):
        src = self.src(plays=[])
        trends = insights.trends_view(self.db, src, "90d", timezone.utc)
        self.assertTrue(trends["buckets"])
        self.assertTrue(all(b["web_ms"] == 0 and b["pages"] is None for b in trends["buckets"]))
        self.assertEqual((trends["top_books"], trends["top_authors"], trends["top_series"]), ([], [], []))
        books = insights.books_view(self.db, src, "90d")
        self.assertEqual((books["abandoned"], books["never_opened"], books["finish"]),
                         ([], {"count": 0, "items": []}, []))
        habits = insights.habits_view(self.db, src, "all", timezone.utc)
        self.assertEqual(sum(map(sum, habits["heatmap"])), 0)
        self.assertEqual(habits["requested"], {"total": 0, "read": 0, "items": []})
        self.assertEqual([b["start"] for b in insights.trends_view(self.db, src, "all", timezone.utc)["buckets"]],
                         ["2026-10-01"])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Routes(Base):
    def setUp(self):
        super().setUp()
        from app.auth import session_manager
        from app.tests.test_ticket_claim_signin import FakeRedis
        for p in (mock.patch.object(session_manager, "get_redis", mock.AsyncMock(return_value=FakeRedis())),
                  mock.patch("app.routers.setup.is_setup_completed", return_value=True),
                  mock.patch.object(insights, "plex_people", mock.AsyncMock(return_value=("", {}))),
                  mock.patch.object(insights, "plex_plays", mock.AsyncMock(return_value=[]))):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(helpers.reset_overrides)

    def get(self, path, user=None):
        return helpers.api_client(self.Session, user=user or dict(helpers.ADMIN)).get(path)

    def test_admin_member_and_bad_input(self):
        self.book(1, "Dune", keys=["5:1"])
        for path in ("/api/admin/insights/trends?period=1y&tz=Asia/Kolkata", "/api/admin/insights/books?period=30d",
                     "/api/admin/insights/habits", "/api/admin/insights/book/1"):
            with self.subTest(path):
                self.assertEqual(self.get(path).status_code, 200)
                self.assertEqual(self.get(path, user=dict(helpers.MEMBER)).status_code, 403)
        self.assertEqual(self.get("/api/admin/insights/trends?period=week").status_code, 422)
        self.assertEqual(self.get("/api/admin/insights/book/99").status_code, 404)
        from app.tests.test_settings_gate import _admin_operations
        found = set(_admin_operations())
        for path in ("/api/admin/insights/trends", "/api/admin/insights/books", "/api/admin/insights/habits",
                     "/api/admin/insights/book/{book_id}"):
            self.assertIn(("get", path), found)


if __name__ == "__main__":
    unittest.main()
