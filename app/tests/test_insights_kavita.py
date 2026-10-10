"""
The nightly Kavita read for Insights (docs/superpowers/specs/2026-10-10-insights-design.md,
sections 4.3 and 11): with the admin key, the minutes Kavita measured each
linked person reading each day (/api/Stats/reading-counts), at most once a
night, GET only, against a fake Kavita on an httpx.MockTransport. A refusal
is recorded so the answers list Kavita as unavailable; Kavita not set up is
nothing to do. Then those minutes in People, a person, Trends and Habits,
always under a kavita_ms key (Kavita's figure, not WebServarr's).
"""
import asyncio
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest import mock

try:
    import httpx
    from app.tests import helpers
    from app.tests.test_insights_api import ME, NOW as VIEW_NOW, THEM, Base
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False
    Base = unittest.TestCase
if HAVE_APP:
    from app.integrations import kavita
    from app.models import KavitaLink, ReadingMinutes, Setting
    from app.services import insights, insights_kavita, insights_store
    from app.utils import identity_key

NOW = datetime(2026, 10, 10, 3, 0)
KEY = "KEY-SENTINEL"
EPUB, PDF = 3, 4


def day(value: str, fmt: int, count: int) -> dict:
    return {"value": f"{value}T00:00:00Z", "format": fmt, "count": count}


class FakeKavita:
    """Kavita 0.9.1.4 as Task 10 found it: reading-counts by day and format,
    gap-filled with zeros. `counts` is {Kavita user id: [entries]}."""

    def __init__(self, counts=None, status=200):
        self.counts = counts if counts is not None else {
            "7": [day("2026-10-08", EPUB, 30), day("2026-10-08", PDF, 5), day("2026-10-09", EPUB, 0)],
            "8": [day("2026-10-09", EPUB, 12)]}
        self.status = status
        self.calls = []
        self.starts = {}

    def handler(self, request):
        path, params = request.url.path, dict(request.url.params)
        self.calls.append((request.method, path))
        if request.method == "POST" and path == "/api/Plugin/authenticate":
            return httpx.Response(200, json={"token": "ADMIN-TOKEN"})
        if request.method != "GET":
            raise AssertionError(f"unexpected write: {request.method} {path}")
        assert request.headers.get("authorization") == "Bearer ADMIN-TOKEN"
        if path == "/api/Users":
            return httpx.Response(200, json=[{"id": 7, "username": "sam"}, {"id": 8, "username": "Kim"}])
        if path == "/api/Stats/reading-counts":
            assert params["TimeZoneId"] == "UTC"
            self.starts[params["userId"]] = params["StartDate"]
            return httpx.Response(self.status, json=self.counts.get(params["userId"], []))
        raise AssertionError(f"unexpected Kavita call: {path}")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Sweep(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.addCleanup(self.db.close)
        self.db.add_all([KavitaLink(identity=ME, kavita_user_id=7, kavita_username="sam", linked_at=NOW),
                         KavitaLink(identity=THEM, kavita_user_id=None, kavita_username="kim", linked_at=NOW)])
        self.db.commit()

    def run_sweep(self, fake, now=NOW, configured=True):
        config = mock.patch.object(kavita, "_config", return_value=("http://kavita.test", KEY)) if configured \
            else mock.patch.object(kavita, "_config", side_effect=kavita.KavitaUnavailable("Kavita is not set up"))
        with config, mock.patch.object(insights_kavita, "SessionLocal", self.Session), \
                mock.patch.object(insights_kavita, "_client", lambda: httpx.AsyncClient(
                    transport=httpx.MockTransport(fake.handler), timeout=5)):
            return asyncio.run(insights_kavita.sweep(now))

    def minutes(self):
        self.db.expire_all()
        return sorted((m.identity, m.day, m.minutes) for m in self.db.query(ReadingMinutes))

    def test_minutes_for_everyone_linked(self):
        fake = FakeKavita()
        self.assertEqual(self.run_sweep(fake), {"people": 2, "days": 2})
        self.assertEqual(self.minutes(), [(ME, date(2026, 10, 8), 35), (THEM, date(2026, 10, 9), 12)])
        first = (NOW.date() - timedelta(days=insights_store.KEEP_DAYS)).isoformat() + "T00:00:00Z"
        self.assertEqual(fake.starts, {"7": first, "8": first})
        self.assertEqual({m for m, _p in fake.calls}, {"POST", "GET"})
        self.assertEqual([c for c in fake.calls if c[0] == "POST"], [("POST", "/api/Plugin/authenticate")])
        self.assertEqual(insights_kavita.last_error(self.db), "")

    def test_the_next_sweep_asks_again_from_just_before_the_latest_day_kept(self):
        self.run_sweep(FakeKavita())
        fake = FakeKavita({"7": [day("2026-10-08", EPUB, 40), day("2026-10-10", EPUB, 3)],
                           "8": [day("2026-10-09", EPUB, 0)]})
        self.assertEqual(self.run_sweep(fake, now=NOW + timedelta(hours=21)), {"people": 2, "days": 2})
        self.assertEqual(fake.starts, {"7": "2026-10-05T00:00:00Z", "8": "2026-10-06T00:00:00Z"})
        self.assertEqual(self.minutes(), [(ME, date(2026, 10, 8), 40), (ME, date(2026, 10, 10), 3),
                                          (THEM, date(2026, 10, 9), 12)])       # a day now 0 keeps what was read

    def test_once_a_night(self):
        self.run_sweep(FakeKavita())
        fake = FakeKavita()
        self.assertEqual(self.run_sweep(fake, now=NOW + timedelta(hours=5)), {"skipped": True})
        self.assertEqual(fake.calls, [])
        self.assertNotEqual(self.run_sweep(FakeKavita(), now=NOW + timedelta(hours=21)), {"skipped": True})

    def test_a_refusal_is_recorded_and_tried_again_in_an_hour(self):
        for status in (400, 403):
            with self.subTest(status=status):
                got = self.run_sweep(FakeKavita(status=status))
                self.assertTrue(got["error"])
                self.db.expire_all()
                error = insights_kavita.last_error(self.db)
                self.assertIn(error, ("Kavita answered HTTP 400", "Kavita refused the API key"))
                self.assertNotIn(KEY, error)
                self.assertEqual(self.run_sweep(FakeKavita(), now=NOW + timedelta(minutes=30)), {"skipped": True})
                self.run_sweep(FakeKavita(), now=NOW + timedelta(minutes=61))
                self.db.expire_all()
                self.assertEqual(insights_kavita.last_error(self.db), "")
                self.db.query(Setting).delete()
                self.db.commit()

    def test_kavita_not_set_up_is_nothing_to_do(self):
        self.assertEqual(self.run_sweep(FakeKavita(), configured=False), {"skipped": True})
        self.assertEqual(insights_kavita.last_error(self.db), "")

    def test_no_one_linked_is_nothing_to_do(self):
        self.db.query(KavitaLink).delete()
        self.db.commit()
        fake = FakeKavita()
        self.assertEqual(self.run_sweep(fake), {"skipped": True})
        self.assertEqual(fake.calls, [])

    def test_a_failed_sweep_makes_answers_say_kavita(self):
        from app.routers import insights as insights_router
        self.run_sweep(FakeKavita(status=403))
        with mock.patch.object(insights, "plex_people", mock.AsyncMock(return_value=("", {}))), \
                mock.patch.object(insights, "plex_plays", mock.AsyncMock(return_value=[])):
            src = asyncio.run(insights_router._sources(self.db, None))
            self.assertEqual(src.unavailable, ["kavita"])
            self.run_sweep(FakeKavita(), now=NOW + timedelta(minutes=61))
            self.db.expire_all()
            self.assertEqual(asyncio.run(insights_router._sources(self.db, None)).unavailable, [])

    def test_minutes_go_after_keep_days(self):
        old = NOW - timedelta(days=insights_store.KEEP_DAYS + 1)
        kept = insights_store.record_reading_minutes(
            self.db, ME, {old.date(): 5, NOW.date(): 7, NOW.date() - timedelta(days=1): 0}, now=NOW)
        self.assertEqual(kept, 2)
        self.assertEqual(insights_store.prune(self.db, now=NOW), 1)
        self.assertEqual(self.minutes(), [(ME, NOW.date(), 7)])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Views(Base):
    def setUp(self):
        super().setUp()
        self.add(ReadingMinutes(identity=ME, day=date(2026, 10, 9), minutes=30, seen_at=VIEW_NOW),
                 ReadingMinutes(identity=ME, day=date(2026, 8, 1), minutes=10, seen_at=VIEW_NOW))

    def test_people_and_a_person(self):
        src = self.src(plays=[])
        sam = insights.people_view(self.db, src)["people"][0]
        self.assertEqual((sam["last_what"], sam["last_active"]), ("reading", "2026-10-09T00:00:00.000Z"))
        self.assertEqual((sam["listened_ms_30d"], sam["plex_ms_30d"], sam["kavita_ms_30d"]), (0, 0, 1800000))
        self.assertEqual(insights.identity_for(self.db, src, identity_key(ME)), ME)
        got = insights.person_view(self.db, src, ME, timezone.utc)
        self.assertEqual(got["totals"]["kavita_ms"], 2400000)
        self.assertEqual(got["weekly"][-1], {"week": "2026-10-05", "web_ms": 0, "plex_ms": 0, "kavita_ms": 1800000})
        self.assertEqual(got["last_active"], "2026-10-09T00:00:00.000Z")

    def test_trends_and_habits(self):
        src = self.src(plays=[])
        trends = insights.trends_view(self.db, src, "30d", timezone.utc)
        by_day = {b["start"]: b["kavita_ms"] for b in trends["buckets"]}
        self.assertEqual((by_day["2026-10-09"], by_day["2026-10-08"], sum(by_day.values())), (1800000, 0, 1800000))
        self.assertEqual(trends["active"][-1], {"week": "2026-10-05", "people": 1})
        self.assertEqual(insights.trends_view(self.db, src, "all", timezone.utc)["buckets"][0]["start"], "2026-08-01")
        self.assertEqual(insights.habits_view(self.db, src, "30d", timezone.utc)["split"]["kavita_ms"], 1800000)
        self.assertEqual(insights.habits_view(self.db, src, "all", timezone.utc)["split"]["kavita_ms"], 2400000)

    def test_none_kept_is_null_in_trends(self):
        self.db.query(ReadingMinutes).delete()
        self.db.commit()
        trends = insights.trends_view(self.db, self.src(plays=[]), "90d", timezone.utc)
        self.assertTrue(all(b["kavita_ms"] is None for b in trends["buckets"]))


if __name__ == "__main__":
    unittest.main()
