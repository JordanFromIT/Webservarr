"""
Insights in Plex's layout: Top users (sessions and time by kind, a picture
when plex.tv has one), listening and reading history (stacked by kind, per
day, week or month, everyone's or one person's) and Top played (audiobooks,
ebooks, authors and series with plays, reads, people and a cover on this
origin), their admin-only routes, and the plex.tv picture that is served
from this origin and fetched from plex.tv alone.
"""
import asyncio
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest import mock

try:
    import httpx

    from app.tests import helpers
    from app.tests.test_insights_api import ME, NOW, THEM, Base
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False
    Base = unittest.TestCase
if HAVE_APP:
    from app.integrations import plex_share
    from app.models import ReadingMinutes, ReadingTotal
    from app.services import insights
    from app.utils import identity_key

H = 3600000
M = 60000


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TopUsers(Base):
    def test_time_by_kind_sessions_and_the_order(self):
        self.book(1, "Dune", keys=["5:1"])
        self.hour(ME, "5:1", datetime(2026, 10, 9, 20), H)
        self.hour(ME, "5:1", datetime(2026, 10, 9, 21), 30 * M)          # the same book, the same day: one session
        self.hour(ME, "5:1", datetime(2026, 10, 1, 9), 10 * M)           # outside the 7 days
        plays = [insights.Play(ME, "5:1", datetime(2026, 10, 9, 8), 20 * M),     # a Plex app, the same day: still one
                 insights.Play(THEM, "5:1", datetime(2026, 10, 8, 8), 5 * H)]
        self.add(ReadingTotal(identity=ME, day=date(2026, 10, 2), pages=100, seen_at=NOW),
                 ReadingTotal(identity=ME, day=date(2026, 10, 8), pages=170, seen_at=NOW),   # pages rose: a session
                 ReadingMinutes(identity=ME, day=date(2026, 10, 7), minutes=120, seen_at=NOW),
                 ReadingMinutes(identity=ME, day=date(2026, 9, 30), minutes=90, seen_at=NOW))  # before the 7 days
        got = insights.top_users_view(self.db, self.src(plays=plays, names={"1001": "Sam"}), "7d", timezone.utc,
                                      thumbs={"2002"})
        self.assertEqual([p["name"] for p in got["people"]], ["Account 2002", "Sam"])   # most time first
        them, me = got["people"]
        self.assertEqual((me["web_ms"], me["plex_ms"], me["kavita_ms"], me["total_ms"]),
                         (90 * M, 20 * M, 2 * H, 90 * M + 20 * M + 2 * H))
        self.assertEqual(me["sessions"], 3)          # Dune on the 9th, ebooks on the 7th and the 8th
        self.assertEqual((them["sessions"], them["plex_ms"]), (1, 5 * H))
        self.assertEqual((me["avatar"], them["avatar"]), (False, True))
        self.assertEqual(me["key"], identity_key(ME))
        self.assertNotIn(ME, repr(got))               # an identity never leaves the server

    def test_nobody_in_the_period_is_an_empty_list(self):
        self.hour(ME, "5:1", datetime(2026, 9, 1, 9), H)
        self.assertEqual(insights.top_users_view(self.db, self.src(plays=[]), "7d", timezone.utc)["people"], [])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class History(Base):
    def test_weeks_stacked_by_kind_with_totals(self):
        self.book(1, "Dune", keys=["5:1"])
        self.hour(ME, "5:1", datetime(2026, 10, 9, 20), H)
        self.hour(THEM, "5:1", datetime(2026, 9, 29, 20), 2 * H)
        plays = [insights.Play(THEM, "5:1", datetime(2026, 10, 6, 8), 30 * M)]
        self.add(ReadingMinutes(identity=ME, day=date(2026, 10, 7), minutes=180, seen_at=NOW))
        got = insights.history_view(self.db, self.src(plays=plays), "30d", timezone.utc)
        self.assertEqual(got["bucket"], "week")
        self.assertEqual([b["start"] for b in got["buckets"]],
                         ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"])
        week = {b["start"]: b for b in got["buckets"]}
        self.assertEqual((week["2026-10-05"]["web_ms"], week["2026-10-05"]["plex_ms"], week["2026-10-05"]["kavita_ms"]),
                         (H, 30 * M, 3 * H))
        self.assertEqual(week["2026-09-28"]["web_ms"], 2 * H)
        self.assertEqual(got["totals"], {"web_ms": 3 * H, "plex_ms": 30 * M, "kavita_ms": 3 * H})
        self.assertTrue(got["reading"])

    def test_one_person_and_days_for_a_week(self):
        self.book(1, "Dune", keys=["5:1"])
        self.hour(ME, "5:1", datetime(2026, 10, 9, 20), H)
        self.hour(THEM, "5:1", datetime(2026, 10, 9, 21), 2 * H)
        got = insights.history_view(self.db, self.src(plays=[]), "7d", timezone.utc, identity=ME)
        self.assertEqual((got["bucket"], len(got["buckets"])), ("day", 8))       # 3 Oct to 10 Oct
        self.assertEqual(got["totals"], {"web_ms": H, "plex_ms": 0, "kavita_ms": 0})
        self.assertFalse(got["reading"])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TopPlayed(Base):
    def test_audiobooks_ebooks_authors_and_series(self):
        self.book(1, "Dune", keys=["5:1"], author="Frank Herbert", series="Dune")
        self.book(2, "Emma", keys=["6:1"], author="Jane Austen")
        self.book(3, "Persuasion", author="Jane Austen", chapter=41)
        self.hour(ME, "5:1", datetime(2026, 10, 9, 20), H)
        self.hour(ME, "5:1", datetime(2026, 10, 8, 20), H)
        self.hour(THEM, "5:1", datetime(2026, 10, 8, 21), H)
        self.hour(THEM, "6:1", datetime(2026, 10, 8, 22), 3 * H)
        plays = [insights.Play(ME, "6:1", datetime(2026, 10, 2, 8), 20 * M)]
        from app.models import EbookPlace
        self.add(EbookPlace(identity=ME, book_id=3, page=300, pages=300, read_at=NOW - timedelta(days=2), seen_at=NOW),
                 EbookPlace(identity=THEM, book_id=3, page=40, pages=300, read_at=NOW - timedelta(days=3), seen_at=NOW))
        got = insights.top_played_view(self.db, self.src(plays=plays), "30d", timezone.utc)
        self.assertEqual([(b["title"], b["plays"], b["people"]) for b in got["audiobooks"]],
                         [("Dune", 3, 2), ("Emma", 2, 2)])
        self.assertEqual(got["audiobooks"][1]["plex_ms"], 20 * M)
        self.assertTrue(got["audiobooks"][0]["cover_url"].startswith("/api/books/1/cover?v="))
        self.assertEqual([(b["title"], b["reads"], b["finished"]) for b in got["ebooks"]], [("Persuasion", 2, 1)])
        self.assertEqual([(a["name"], a["plays"], a["reads"], a["people"]) for a in got["authors"]],
                         [("Jane Austen", 2, 2, 2), ("Frank Herbert", 3, 0, 2)])
        self.assertEqual([(s["name"], s["book_id"]) for s in got["series"]], [("Dune", 1)])
        self.assertTrue(got["series"][0]["cover_url"].startswith("/api/books/1/cover"))

    def test_one_persons_and_an_empty_install(self):
        self.book(1, "Dune", keys=["5:1"])
        self.hour(ME, "5:1", datetime(2026, 10, 9, 20), H)
        self.hour(THEM, "5:1", datetime(2026, 10, 9, 21), H)
        mine = insights.top_played_view(self.db, self.src(plays=[]), "30d", timezone.utc, identity=ME)
        self.assertEqual([(b["plays"], b["people"]) for b in mine["audiobooks"]], [(1, 1)])
        self.db.query(insights.ListeningHourly).delete()
        self.db.commit()
        empty = insights.top_played_view(self.db, self.src(plays=[]), "all", timezone.utc)
        self.assertEqual((empty["audiobooks"], empty["ebooks"], empty["authors"], empty["series"]), ([], [], [], []))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class AvatarAddress(unittest.TestCase):
    def test_only_https_on_plex_tv(self):
        good = "https://plex.tv/users/abc/avatar?c=1"
        self.assertEqual(plex_share.avatar_url(good), good)
        for bad in ("http://plex.tv/users/abc/avatar", "https://evil.test/a.png", "https://plex.tv.evil.test/a",
                    "https://user@plex.tv/a", "javascript:alert(1)", None, 5, "https://plex.tv/" + "a" * 600):
            with self.subTest(bad=bad):
                self.assertEqual(plex_share.avatar_url(bad), "")

    def fetch(self, handler):
        calls = []

        def wrapped(request):
            calls.append((str(request.url), request.headers.get("x-plex-token")))
            return handler(request)
        with mock.patch.object(plex_share, "_client", lambda: httpx.AsyncClient(
                transport=httpx.MockTransport(wrapped), timeout=plex_share.TIMEOUT)):
            return asyncio.run(plex_share.avatar_image("https://plex.tv/users/abc/avatar?c=1")), calls

    def test_a_picture_through_one_redirect_without_a_token(self):
        def handler(request):
            if request.url.host == "plex.tv":
                return httpx.Response(302, headers={"location": "https://images.plex.tv/photo/abc.png"})
            return httpx.Response(200, content=b"PNG", headers={"content-type": "image/png"})
        (content, kind), calls = self.fetch(handler)
        self.assertEqual((content, kind), (b"PNG", "image/png"))
        self.assertEqual([token for _url, token in calls], [None, None])

    def test_refusals(self):
        cases = {
            "a redirect to an address": lambda r: httpx.Response(302, headers={"location": "https://10.0.0.1/a.png"}),
            "a redirect to plain http": lambda r: httpx.Response(302, headers={"location": "http://images.plex.tv/a"}),
            "not an image": lambda r: httpx.Response(200, content=b"<svg/>", headers={"content-type": "image/svg+xml"}),
            "too large": lambda r: httpx.Response(200, content=b"x" * (plex_share.AVATAR_MAX_BYTES + 1),
                                                  headers={"content-type": "image/jpeg"}),
            "a redirect loop": lambda r: httpx.Response(302, headers={"location": "https://plex.tv/again"}),
            "a refusal": lambda r: httpx.Response(404),
        }
        for name, handler in cases.items():
            with self.subTest(name), self.assertRaises(plex_share.PlexShareUnavailable):
                self.fetch(handler)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Routes(Base):
    def setUp(self):
        super().setUp()
        from app.auth import session_manager
        from app.tests.test_ticket_claim_signin import FakeRedis
        for p in (mock.patch.object(session_manager, "get_redis", mock.AsyncMock(return_value=FakeRedis())),
                  mock.patch("app.routers.setup.is_setup_completed", return_value=True),
                  mock.patch.object(insights, "plex_people", mock.AsyncMock(return_value=("", {}))),
                  mock.patch.object(insights, "plex_thumbs", mock.AsyncMock(
                      return_value={"1001": "https://plex.tv/users/abc/avatar"})),
                  mock.patch.object(insights, "plex_plays", mock.AsyncMock(return_value=[]))):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(helpers.reset_overrides)

    def get(self, path, user=None):
        return helpers.api_client(self.Session, user=user or dict(helpers.ADMIN)).get(path)

    def test_admin_only_and_bad_input(self):
        self.book(1, "Dune", keys=["5:1"])
        self.hour(ME, "5:1", datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=2), H)
        me = identity_key(ME)
        for path in ("/api/admin/insights/top-users?period=7d&tz=Europe/London",
                     "/api/admin/insights/history?period=90d", f"/api/admin/insights/history?person={me}",
                     "/api/admin/insights/top-played?period=all", f"/api/admin/insights/top-played?person={me}"):
            with self.subTest(path):
                self.assertEqual(self.get(path).status_code, 200)
                self.assertEqual(self.get(path, user=dict(helpers.MEMBER)).status_code, 403)
        top = self.get("/api/admin/insights/top-users?period=7d").json()
        self.assertEqual([(p["key"], p["avatar"]) for p in top["people"]], [(me, True)])
        self.assertEqual(self.get("/api/admin/insights/history?period=week").status_code, 422)
        self.assertEqual(self.get("/api/admin/insights/history?person=nobody").status_code, 422)
        self.assertEqual(self.get("/api/admin/insights/top-played?person=" + "f" * 24).status_code, 404)
        from app.tests.test_settings_gate import _admin_operations
        found = set(_admin_operations())
        for path in ("/api/admin/insights/top-users", "/api/admin/insights/history",
                     "/api/admin/insights/top-played", "/api/admin/insights/avatar"):
            self.assertIn(("get", path), found)

    def test_the_picture_is_served_from_this_origin(self):
        me = identity_key(ME)
        with mock.patch.object(plex_share, "avatar_image", mock.AsyncMock(return_value=(b"PNG", "image/png"))) as fetch:
            r = self.get(f"/api/admin/insights/avatar?key={me}")
            self.assertEqual((r.status_code, r.content, r.headers["content-type"]), (200, b"PNG", "image/png"))
            self.assertIn("private", r.headers["cache-control"])
            self.assertEqual(r.headers["content-security-policy"], "sandbox")
            fetch.assert_awaited_once_with("https://plex.tv/users/abc/avatar")
            self.assertEqual(self.get(f"/api/admin/insights/avatar?key={me}", user=dict(helpers.MEMBER)).status_code, 403)
            self.assertEqual(self.get("/api/admin/insights/avatar?key=" + "f" * 24).status_code, 404)
        with mock.patch.object(plex_share, "avatar_image",
                               mock.AsyncMock(side_effect=plex_share.PlexShareUnavailable("no"))):
            self.assertEqual(self.get(f"/api/admin/insights/avatar?key={me}").status_code, 404)


if __name__ == "__main__":
    unittest.main()
