"""
Insights, the core (docs/superpowers/specs/2026-10-10-insights-design.md,
sections 3, 4, 6, 7 and 10): web listening by hour, Plex app plays without the
web player's own, names, the Right now, People and person answers through the
admin-only routes, and the wording that tells people the admin can see.
"""
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

try:
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False
if HAVE_APP:
    from app.config import settings
    from app.models import (Book, BookAudioEdition, BookRequester, BookVisit, EbookPlace, ListeningHourly,
                            ListeningLog, ListeningPosition, Setting)
    from app.services import insights, listening
    from app.utils import identity_key, utc_iso

NOW = datetime(2026, 10, 10, 12, 30)
ME, THEM = "plex:1001", "plex:2002"
APP = Path(__file__).resolve().parent.parent


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Base(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.addCleanup(self.db.close)
        secret = mock.patch.object(settings, "app_secret_key", "insights-test-secret")
        secret.start()
        self.addCleanup(secret.stop)

    def add(self, *rows):
        self.db.add_all(rows)
        self.db.commit()

    def book(self, book_id, title, keys=(), author="An Author", series="", chapter=None, added=None):
        self.add(Book(id=book_id, title=title, sort_title=title, author=author, series=series, description="",
                      kavita_chapter_id=chapter, kavita_series_id=9 if chapter else None, cover_source="plex",
                      updated_at=NOW, added_at=added or NOW, plex_book_key=keys[0] if keys else None))
        for key in keys:
            self.add(BookAudioEdition(book_id=book_id, plex_book_key=key, narrator=""))

    def place(self, identity, key, at, ms=600000, total=36000000, chapter="Chapter 3", event=None):
        self.add(ListeningPosition(identity=identity, book_key=key, track_key="6", offset_ms=0, duration_ms=0,
                                   updated_at=at, device="Chrome", source="web", book_ms=ms,
                                   book_duration_ms=total, chapter_label=chapter, book_title="Kept " + key))
        if event:
            self.add(ListeningLog(identity=identity, book_key=key, track_key="6", offset_ms=0, event=event, at=at))

    def hour(self, identity, key, at, ms, source="web"):
        self.add(ListeningHourly(identity=identity, hour=at, book_key=key, source=source, ms=ms))

    def src(self, plays=(), names=None, unavailable=()):
        return insights.Sources(listens=insights.listens(self.db), plays=None if plays is None else list(plays),
                                names=names or {}, now=NOW, unavailable=list(unavailable))


class Listens(Base):
    def test_finished_hours_from_the_rollup_and_the_rest_from_the_log(self):
        self.hour(ME, "5:1", datetime(2026, 10, 10, 10), 60000)
        self.add(Setting(key=listening.HOURS_THROUGH_KEY, value=utc_iso(datetime(2026, 10, 10, 11))))
        for s in (0, 10, 20):
            self.add(ListeningLog(identity=ME, book_key="5:1", track_key="6", offset_ms=0, event="checkin",
                                  at=datetime(2026, 10, 10, 11, 5, s)))
        got = sorted((l.hour, l.ms) for l in insights.listens(self.db))
        self.assertEqual(got, [(datetime(2026, 10, 10, 10), 60000), (datetime(2026, 10, 10, 11), 20000)])

    def test_since_leaves_out_older_hours(self):
        self.hour(ME, "5:1", datetime(2026, 9, 1, 10), 1)
        self.hour(ME, "5:1", datetime(2026, 10, 9, 10), 2)
        self.add(Setting(key=listening.HOURS_THROUGH_KEY, value=utc_iso(datetime(2026, 10, 10, 12))))
        self.assertEqual([l.ms for l in insights.listens(self.db, datetime(2026, 10, 1))], [2])


class AppPlays(Base):
    def test_a_play_the_web_player_caused_is_left_out(self):
        web = [insights.Listen(ME, datetime(2026, 10, 9, 20), "5:1", "web", 600000)]
        plays = [insights.Play(ME, "5:1", datetime(2026, 10, 9, 20, 40), 1200000),     # the web player's own
                 insights.Play(ME, "7:1", datetime(2026, 10, 9, 20, 40), 1200000),     # another book
                 insights.Play(ME, "5:1", datetime(2026, 10, 9, 23, 30), 1200000),     # hours later
                 insights.Play(THEM, "5:1", datetime(2026, 10, 9, 20, 40), 1200000)]   # someone else
        kept = insights.app_plays(plays, web)
        self.assertEqual([(p.identity, p.book_key, p.at.hour) for p in kept],
                         [(ME, "7:1", 20), (ME, "5:1", 23), (THEM, "5:1", 20)])

    def test_plex_history_as_people_with_the_owner_as_1(self):
        events = [{"account": "1", "book_key": "5:1", "track_key": "11", "viewed_at": "2026-10-09T20:40:00.000Z"},
                  {"account": "2002", "book_key": "5:1", "track_key": "12", "viewed_at": "2026-10-09T21:00:00.000Z"},
                  {"account": "3003", "book_key": "5:1", "track_key": "13", "viewed_at": "not a time"}]
        plays = insights.to_plays(events, "1001", {"11": 600000})
        self.assertEqual([(p.identity, p.ms, p.at) for p in plays],
                         [(ME, 600000, datetime(2026, 10, 9, 20, 40)), (THEM, 0, datetime(2026, 10, 9, 21))])
        self.assertEqual(insights.to_plays(events[:1], "", {}), [])


class Now(Base):
    def test_playing_paused_and_left(self):
        self.book(1, "Dune", keys=["5:1"])
        self.place(ME, "5:1", NOW - timedelta(seconds=20), event="checkin")
        self.place(THEM, "5:1", NOW - timedelta(minutes=4), event="pause")
        self.place("plex:3003", "5:1", NOW - timedelta(minutes=2), event="leave")
        self.place("plex:4004", "5:1", NOW - timedelta(minutes=30), event="checkin")
        got = insights.now_view(self.db, {"1001": "Sam"}, NOW)
        self.assertEqual([(i["name"], i["state"], i["title"], i["where"]) for i in got["listening"]],
                         [("Sam", "playing", "Dune", "web"), ("Account 2002", "paused", "Dune", "web")])
        self.assertEqual(got["listening"][0]["key"], identity_key(ME))
        self.assertNotIn("plex:", repr(got))


class People(Base):
    def test_most_recent_first_with_what_and_current_books(self):
        self.book(1, "Dune", keys=["5:1"])
        self.book(2, "Emma", keys=["6:1"])
        self.book(3, "Ulysses", chapter=31)
        self.place(ME, "5:1", NOW - timedelta(days=2), ms=18000000)
        self.place(ME, "6:1", NOW - timedelta(days=3), ms=36000000)
        self.add(EbookPlace(identity=ME, book_id=3, page=10, pages=100, read_at=NOW - timedelta(days=1), seen_at=NOW))
        self.add(BookVisit(identity=THEM, seen_at=NOW - timedelta(hours=1)))
        self.hour(ME, "5:1", datetime(2026, 10, 8, 9), 3600000)
        plays = [insights.Play(THEM, "6:1", NOW - timedelta(days=40), 1200000)]
        got = insights.people_view(self.db, self.src(plays=plays, names={"1001": "Sam"}))
        people = got["people"]
        self.assertEqual([(p["name"], p["last_what"]) for p in people], [("Account 2002", "visit"), ("Sam", "reading")])
        sam = people[1]
        self.assertEqual((sam["listened_ms_30d"], sam["plex_ms_30d"]), (3600000, 0))
        self.assertEqual([(c["title"], c["format"], c["percent"]) for c in sam["current"]],
                         [("Ulysses", "ebook", 10), ("Dune", "audio", 50)])
        self.assertEqual(people[0]["current"], [])
        self.assertEqual(got["unavailable"], [])

    def test_an_empty_install(self):
        got = insights.people_view(self.db, self.src(plays=[]))
        self.assertEqual(got["people"], [])
        self.assertEqual(set(got["tracking"]), {"requests", "reading", "ebook_places", "hours"})

    def test_a_name_is_passed_on_as_it_is(self):
        self.add(BookVisit(identity=ME, seen_at=NOW))
        got = insights.people_view(self.db, self.src(plays=[], names={"1001": "<b>Sam</b>"}))
        self.assertEqual(got["people"][0]["name"], "<b>Sam</b>")      # the page sets it as text


class Person(Base):
    def test_a_persons_history(self):
        self.book(1, "Dune", keys=["5:1"])
        self.place(ME, "5:1", NOW - timedelta(days=2), ms=36000000, event="end")
        self.hour(ME, "5:1", datetime(2026, 10, 8, 9), 3600000)
        plays = [insights.Play(ME, "5:1", datetime(2026, 10, 1, 9), 1200000)]
        self.add(BookRequester(identity=ME, foreign_id="gr:1", title="dune", format="both",
                               requested_at=datetime(2026, 9, 30)))
        got = insights.person_view(self.db, self.src(plays=plays, names={"1001": "Sam"}), ME, timezone.utc)
        self.assertEqual(got["totals"], {"listened_ms": 3600000, "plex_ms": 1200000, "finished": 1, "pages_read": None})
        self.assertEqual(len(got["weekly"]), insights.HISTORY_WEEKS)
        self.assertEqual(got["weekly"][-1], {"week": "2026-10-05", "web_ms": 3600000, "plex_ms": 0})
        self.assertEqual(got["weekly"][-2], {"week": "2026-09-28", "web_ms": 0, "plex_ms": 1200000})
        self.assertEqual([(b["title"], b["finished"], b["listened_ms"], b["plex_ms"]) for b in got["books"]],
                         [("Dune", True, 3600000, 1200000)])
        self.assertEqual([(r["title"], r["book_id"], r["started_at"]) for r in got["requests"]],
                         [("dune", 1, "2026-10-01T09:00:00.000Z")])

    def test_a_key_finds_the_person_and_nothing_else(self):
        self.add(BookVisit(identity=ME, seen_at=NOW))
        src = self.src(plays=[])
        self.assertEqual(insights.identity_for(self.db, src, identity_key(ME)), ME)
        self.assertIsNone(insights.identity_for(self.db, src, identity_key(THEM)))


class Routes(Base):
    def setUp(self):
        super().setUp()
        from app.auth import session_manager
        from app.tests.test_ticket_claim_signin import FakeRedis
        self.redis = FakeRedis()
        self.people = mock.AsyncMock(return_value=("1001", {"1001": "Sam"}))
        self.plays = mock.AsyncMock(return_value=[])
        for p in (mock.patch.object(session_manager, "get_redis", mock.AsyncMock(return_value=self.redis)),
                  mock.patch("app.routers.setup.is_setup_completed", return_value=True),
                  mock.patch.object(insights, "plex_people", self.people),
                  mock.patch.object(insights, "plex_plays", self.plays)):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(helpers.reset_overrides)

    def get(self, path, user=None):
        return helpers.api_client(self.Session, user=user or dict(helpers.ADMIN)).get(path)

    def test_the_admin_gets_each_answer(self):
        self.add(BookVisit(identity=ME, seen_at=NOW))
        for path in ("/api/admin/insights/now", "/api/admin/insights/people",
                     "/api/admin/insights/person?key=" + identity_key(ME) + "&tz=Europe/London"):
            with self.subTest(path):
                r = self.get(path)
                self.assertEqual(r.status_code, 200, r.text)
                self.assertNotIn("plex:1001", r.text)

    def test_a_member_is_refused(self):
        for path in ("/api/admin/insights/now", "/api/admin/insights/people",
                     "/api/admin/insights/person?key=" + "0" * 24):
            with self.subTest(path):
                self.assertEqual(self.get(path, user=dict(helpers.MEMBER)).status_code, 403)

    def test_an_unknown_or_malformed_key(self):
        self.assertEqual(self.get("/api/admin/insights/person?key=" + "a" * 24).status_code, 404)
        self.assertEqual(self.get("/api/admin/insights/person?key=PLEX:1001").status_code, 422)

    def test_plex_down_is_unavailable_not_an_error(self):
        self.plays.return_value = None
        r = self.get("/api/admin/insights/people")
        self.assertEqual((r.status_code, r.json()["unavailable"]), (200, ["plex"]))
        self.assertEqual([k for k in self.redis.data if "answer:" in k], [])

    def test_an_answer_is_kept_for_five_minutes(self):
        with mock.patch.object(insights, "people_view", wraps=insights.people_view) as view:
            self.get("/api/admin/insights/people")
            self.get("/api/admin/insights/people")
        self.assertEqual(view.call_count, 1)

    def test_the_settings_gate_sweeps_these_routes(self):
        from app.tests.test_settings_gate import _admin_operations
        found = set(_admin_operations())
        for path in ("/api/admin/insights/now", "/api/admin/insights/people", "/api/admin/insights/person"):
            self.assertIn(("get", path), found)


class Wording(unittest.TestCase):
    """Spec section 10: tell them, then show you."""

    def test_people_are_told_and_the_comments_say_so(self):
        self.assertIn("You and the admin can see these.", (APP / "static" / "books-stats.html").read_text())
        self.assertNotIn("Only you can see these.", (APP / "static" / "books-stats.html").read_text())
        self.assertEqual((APP / "models.py").read_text().count("the admin sees everyone's on the Insights page"), 2)
        self.assertIn("The admin's Insights page reads", (APP / "services" / "listening.py").read_text())
        self.assertIn("for the admin only, show", (APP / "integrations" / "plex_player.py").read_text())


if __name__ == "__main__":
    unittest.main()
