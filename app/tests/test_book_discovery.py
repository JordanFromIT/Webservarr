"""
Books discovery (sub-project 3c, task 1): Recently added with New badges,
Popular on the server, a person's own listening stats with the daily rollup,
series follows and "New in your series" notifications
(app/services/book_discovery.py, app/routers/book_discovery.py).

The routes run end to end on test_books_api's in-memory catalog (Kavita and
Plex faked at their function boundaries; Kavita's stats and Plex's history
at the httpx layer). Announcing runs through real catalog rebuilds
(test_book_catalog's fake sources), pushes are faked, and the two-worker
cases run on a real SQLite file with several connections, or as two real
processes for the migration. No test reaches Kavita, Plex or the dev
instance's data.
"""
import asyncio
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from app.tests import helpers

try:
    import httpx
    from sqlalchemy import inspect, text
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

if HAVE_APP:
    # Not in the guard above: a missing module of this work must fail the suite, not skip it.
    from app.integrations import kavita
    from app.integrations import plex_player as pp
    from app.models import (Book, BookAnnounced, BookFollow, BookListEntry, BookPopularity, BookVisit,
                            ListeningDaily, ListeningLog, ListeningPosition, Notification, Setting)
    from app.routers.notifications import _email_hash
    from app.services import book_discovery, listening
    from app.tests.test_book_catalog import STARTUP_CHILD, CatalogCase, ebook, run_together
    from app.tests.test_books_api import A, B, ORIGIN, BooksBase, kplace, place, when

ME = "plex:1001"
OTHER = "plex:1002"


def log_session(db, identity, key, start, seconds, step=10, event="checkin"):
    """Check-ins every `step` seconds for `seconds`: `seconds` of listening."""
    for i in range(seconds // step + 1):
        db.add(ListeningLog(identity=identity, book_key=key, track_key="t", offset_ms=i, device="d",
                            event=event, at=start + timedelta(seconds=i * step)))
    db.commit()


def listened(db, identity, key, ms, at):
    db.add(ListeningPosition(identity=identity, book_key=key, track_key="t", offset_ms=0, duration_ms=0,
                             updated_at=at, device="", source="web", book_ms=ms, book_duration_ms=10 ** 8))
    db.commit()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class DiscoveryBase(BooksBase):
    def setUp(self):
        super().setUp()
        self.now = when(20)
        self.push = mock.AsyncMock(return_value=0)
        for p in (mock.patch.object(book_discovery, "_now", lambda: self.now),
                  mock.patch.object(book_discovery, "SessionLocal", self.Session),
                  mock.patch.object(book_discovery, "send_push_to_users", self.push)):
            p.start()
            self.addCleanup(p.stop)

    def send(self, method, path, json_body=None, origin=ORIGIN):
        headers = {"Origin": origin} if origin else {}
        return self.client.request(method, path, json=json_body, headers=headers)

    def set_dates(self, book_id, ebook=None, audio=None):
        db = self.Session()
        try:
            book = db.get(Book, book_id)
            book.ebook_added_at, book.audio_added_at = ebook, audio
            db.commit()
        finally:
            db.close()

    def recent(self):
        return {i["id"]: i["is_new"] for i in self.ok("/api/books/recent")["items"]}

    def visit(self, identity=ME):
        db = self.Session()
        try:
            row = db.get(BookVisit, identity)
            if row is not None:
                db.expunge(row)
            return row
        finally:
            db.close()


class Recent(DiscoveryBase):
    def test_a_first_visit_has_no_badges_and_a_quick_revisit_does_not_clear_them(self):
        shelf = self.recent()
        self.assertEqual(sorted(shelf), [1, 2, 3, 4, 6, 7, 8])          # 5 is in a library A can't reach
        self.assertFalse(any(shelf.values()), "a first visit badges nothing")
        self.assertIsNone(self.visit().prev_seen_at)
        self.now = when(20) + timedelta(minutes=10)
        self.assertFalse(any(self.recent().values()))                  # still the first visit
        self.assertIsNone(self.visit().prev_seen_at)

        self.set_dates(4, ebook=when(20) + timedelta(hours=1))         # Emma arrives after that visit
        self.now = when(20) + timedelta(hours=2)
        self.assertEqual([b for b, new in self.recent().items() if new], [4])
        self.now = when(20) + timedelta(hours=2, minutes=20)           # a quick revisit: the badge stays
        self.assertEqual([b for b, new in self.recent().items() if new], [4])
        self.now = when(20) + timedelta(hours=2, minutes=40)           # still browsing (gaps under 30 min)
        self.assertEqual([b for b, new in self.recent().items() if new], [4])
        self.now = when(20) + timedelta(hours=5)                       # the next visit: seen now
        self.assertEqual([b for b, new in self.recent().items() if new], [])

    def test_shape_order_and_card(self):
        items = self.ok("/api/books/recent")["items"]
        self.assertEqual([i["id"] for i in items], [3, 2, 1, 8, 7, 6, 4])   # newest first
        self.assertEqual(set(items[0]), {"kind", "id", "title", "author", "cover_url", "formats", "is_new"})

    def test_a_later_format_makes_a_book_new_but_only_a_format_the_caller_can_reach(self):
        self.recent()
        self.set_dates(6, ebook=when(7), audio=when(20) + timedelta(hours=1))   # Villette's audiobook arrives
        self.now = when(21)
        items = self.ok("/api/books/recent")["items"]
        self.assertEqual((items[0]["id"], items[0]["is_new"]), (6, True))
        self.library_access.side_effect = pp.NoServerAccess("no audiobooks in this share")
        shelf = self.recent()
        self.assertFalse(shelf[6], "the audiobook the caller can't hear does not make it new")
        self.assertNotIn(7, shelf)                                      # an audiobook-only book is not theirs

    def test_only_the_last_thirty_days_and_at_most_twelve(self):
        self.now = when(40)
        self.assertEqual(list(self.recent()), [3, 2, 1])                # added days 12, 11, 10
        self.now = when(20)
        with mock.patch.object(book_discovery, "RECENT_MAX", 2):
            self.assertEqual(list(self.recent()), [3, 2])

    def test_visits_are_per_person_and_keep_their_email(self):
        self.as_user({**A, "email": "Sam@Example.com"})
        self.recent()
        self.assertEqual(self.visit().email, "sam@example.com")
        self.now = when(21)
        self.as_user(A)                                                  # a session without an email
        self.recent()
        self.assertEqual(self.visit().email, "sam@example.com")
        self.assertEqual(self.visit().prev_seen_at, when(20))
        self.as_user(B)
        self.assertFalse(any(self.recent().values()), "B's first visit, whatever A's are")
        self.assertIsNone(self.visit(OTHER).prev_seen_at)
        self.assertEqual(self.visit().prev_seen_at, when(20))

    def test_an_account_without_an_identity_records_nothing(self):
        self.as_user({"user_id": "", "username": "x", "auth_method": "oidc", "email": "x@example.com"})
        self.assertEqual(self.get("/api/books/recent").status_code, 200)
        db = self.Session()
        try:
            self.assertEqual(db.query(BookVisit).count(), 0)
        finally:
            db.close()


class Popular(DiscoveryBase):
    def refresh(self, plays=(), now=None):
        if isinstance(plays, Exception):
            history = mock.AsyncMock(side_effect=plays)
        else:
            history = mock.AsyncMock(return_value=list(plays))
        with mock.patch.object(pp, "play_history", history):
            asyncio.run(book_discovery.refresh(now or self.now))
        return history

    def shelf(self):
        return {i["id"]: i["listeners_label"] for i in self.ok("/api/books/popular")["items"]}

    def test_two_listeners_never_show_three_do(self):
        listened(self.db, "plex:1", "14:1", 600_000, self.now)
        listened(self.db, "plex:2", "14:1", 600_000, self.now)
        self.refresh()
        self.assertEqual(self.shelf(), {})
        listened(self.db, "plex:3", "14:1", 600_000, self.now)
        self.assertEqual(self.shelf(), {}, "computed hourly, not on the request")
        self.refresh()
        r = self.get("/api/books/popular")
        self.assertEqual(r.json(), {"items": [{**r.json()["items"][0], "id": 7, "listeners_label": "3+ listeners"}]})
        self.assertNotIn("plex:", r.text)
        self.assertNotIn('"listeners"', r.text)

    def test_the_ninety_day_window_at_both_edges(self):
        edge = self.now - book_discovery.POPULAR_WINDOW
        listened(self.db, "plex:1", "14:1", 600_000, self.now)
        listened(self.db, "plex:2", "14:1", 600_000, self.now)
        listened(self.db, "plex:3", "14:1", 600_000, edge - timedelta(seconds=1))
        self.refresh()
        self.assertEqual(self.shelf(), {}, "the third listener is just outside the window")
        self.db.query(ListeningPosition).filter(ListeningPosition.identity == "plex:3").update(
            {"updated_at": edge})
        self.db.commit()
        self.refresh()
        self.assertEqual(self.shelf(), {7: "3+ listeners"})
        self.refresh(now=self.now + timedelta(seconds=1))               # an hour later the edge has moved on
        self.assertEqual(self.shelf(), {})

    def test_a_mis_tap_and_a_second_edition_do_not_make_a_listener(self):
        listened(self.db, "plex:1", "10:1", 600_000, self.now)
        listened(self.db, "plex:1", "11:1", 600_000, self.now)           # the same person, another narration
        listened(self.db, "plex:2", "10:1", 600_000, self.now)
        listened(self.db, "plex:3", "11:1", book_discovery.LISTENER_MS - 1, self.now)
        self.refresh()
        self.assertEqual(self.shelf(), {})
        listened(self.db, "plex:4", "11:1", book_discovery.LISTENER_MS, self.now)
        self.refresh()
        self.assertEqual(self.shelf(), {1: "3+ listeners"})

    def test_time_in_the_log_counts_a_listener_whose_place_has_no_book_time(self):
        for who in ("plex:1", "plex:2"):
            listened(self.db, who, "13:1", 600_000, self.now)
        log_session(self.db, "plex:3", "13:1", self.now - timedelta(days=3), 290)
        self.refresh()
        self.assertEqual(self.shelf(), {})
        log_session(self.db, "plex:3", "13:1", self.now - timedelta(days=2), 20)
        self.refresh()
        self.assertEqual(self.shelf(), {6: "3+ listeners"})

    def test_plex_history_counts_but_is_never_added_to_our_own(self):
        listened(self.db, "plex:1", "14:1", 600_000, self.now)
        listened(self.db, "plex:2", "14:1", 600_000, self.now)
        plays = [("501", "14:1"), ("502", "14:1"), ("502", "14:1")]
        history = self.refresh(plays)
        self.assertEqual(self.shelf(), {}, "2 and 2 people who may be the same: not 4")
        self.assertEqual(history.await_args.args[0], self.now - book_discovery.POPULAR_WINDOW)
        self.refresh(plays + [("503", "14:1"), ("504", "99:1")])        # a key not in the catalog counts for nothing
        self.assertEqual(self.shelf(), {7: "3+ listeners"})

    def test_without_plex_history_our_own_data_stands(self):
        for who in ("plex:1", "plex:2", "plex:3"):
            listened(self.db, who, "14:1", 600_000, self.now)
        self.refresh(pp.PlayerUnavailable("Plex is unavailable"))
        self.assertEqual(self.shelf(), {7: "3+ listeners"})
        self.refresh(pp.PlayerOff("No audiobook library is configured"))
        self.assertEqual(self.shelf(), {7: "3+ listeners"})

    def test_labels_are_rounded_down_and_never_below_the_floor(self):
        label = book_discovery.listeners_label
        self.assertEqual([label(n) for n in (3, 4, 5, 9, 10, 19, 20, 49, 50, 99, 100, 5000)],
                         ["3+ listeners", "3+ listeners", "5+ listeners", "5+ listeners", "10+ listeners",
                          "10+ listeners", "20+ listeners", "20+ listeners", "50+ listeners", "50+ listeners",
                          "100+ listeners", "100+ listeners"])
        with self.assertRaises(StopIteration):
            label(2)

    def test_a_stored_count_under_the_floor_or_a_book_out_of_reach_is_never_shown(self):
        self.db.add_all([BookPopularity(book_id=7, listeners=2, computed_at=self.now),
                         BookPopularity(book_id=5, listeners=40, computed_at=self.now),
                         BookPopularity(book_id=6, listeners=12, computed_at=self.now),
                         BookPopularity(book_id=4, listeners=60, computed_at=self.now)])
        self.db.commit()
        self.assertEqual(list(self.shelf().items()), [(4, "50+ listeners"), (6, "10+ listeners")])


class Stats(DiscoveryBase):
    NOW = datetime(2026, 9, 20, 12, 0, 0)        # a Sunday

    def setUp(self):
        super().setUp()
        self.now = self.NOW

    def stats(self, **params):
        return self.ok("/api/books/me/stats", **params)

    def test_time_is_wall_time_between_check_ins(self):
        start = self.NOW - timedelta(days=1)
        log_session(self.db, ME, "14:1", start, 600)                       # 61 check-ins 10 s apart
        self.db.add(ListeningLog(identity=ME, book_key="14:1", track_key="t", offset_ms=0, device="d",
                                 event="pause", at=start + timedelta(seconds=610)))
        # A gap over 30 s is not listening, and nothing counts after a pause.
        self.db.add_all([ListeningLog(identity=ME, book_key="14:1", track_key="t", offset_ms=0, device="d",
                                      event="checkin", at=start + timedelta(seconds=s)) for s in (700, 740)])
        self.db.commit()
        body = self.stats()
        self.assertEqual((body["listened_ms_6mo"], body["listened_ms_all"]), (610_000, 610_000))

    def test_two_devices_at_once_are_not_counted_twice(self):
        start = self.NOW - timedelta(hours=3)
        log_session(self.db, ME, "14:1", start, 60)
        log_session(self.db, ME, "13:1", start + timedelta(seconds=5), 60)
        self.assertEqual(self.stats()["listened_ms_6mo"], 65_000)

    def test_streak_and_time_zone(self):
        for at in (datetime(2026, 9, 19, 15), datetime(2026, 9, 18, 15), datetime(2026, 9, 17, 3),
                   datetime(2026, 9, 15, 15)):
            log_session(self.db, ME, "14:1", at, 60)
        self.assertEqual(self.stats()["streak_days"], 3, "19, 18, 17; today not yet listened")
        # 03:00 UTC on the 17th is the evening of the 16th in New York: the run breaks after the 18th.
        self.assertEqual(self.stats(tz="America/New_York")["streak_days"], 2)
        self.assertEqual(self.stats(tz="Not/AZone")["streak_days"], 3, "an unknown zone is UTC")
        self.assertEqual(self.get("/api/books/me/stats", tz="x" * 65).status_code, 422)
        log_session(self.db, ME, "14:1", datetime(2026, 9, 20, 9), 60)
        self.assertEqual(self.stats()["streak_days"], 4)

    def test_weekly_is_twelve_weeks_from_monday(self):
        log_session(self.db, ME, "14:1", datetime(2026, 9, 14, 8), 60)    # this week (Monday the 14th)
        log_session(self.db, ME, "14:1", datetime(2026, 9, 13, 8), 120)   # last week's Sunday
        log_session(self.db, ME, "14:1", datetime(2026, 6, 1, 8), 120)    # long before the twelve weeks
        weekly = self.stats()["weekly"]
        self.assertEqual(len(weekly), 12)
        self.assertEqual(weekly[-1], {"week": "2026-09-14", "ms": 60_000})
        self.assertEqual(weekly[-2], {"week": "2026-09-07", "ms": 120_000})
        self.assertEqual(weekly[0]["week"], "2026-06-29")
        self.assertEqual(sum(w["ms"] for w in weekly), 180_000)

    def test_books_finished_count_each_book_once(self):
        place(self.db, ME, "10:1", self.NOW, book_ms=9_800_000, duration=10_000_000)   # 98%
        place(self.db, ME, "11:1", self.NOW, book_ms=10, duration=10_000_000, end=True)  # the same book, ended
        place(self.db, ME, "14:1", self.NOW, book_ms=5_000_000, duration=10_000_000)   # half way
        place(self.db, ME, "99:1", self.NOW, book_ms=100, duration=100)               # a book gone from the library
        place(self.db, OTHER, "13:1", self.NOW, book_ms=100, duration=100)
        self.assertEqual(self.stats()["finished"], 2)

    def test_top_authors_by_time(self):
        log_session(self.db, ME, "14:1", self.NOW - timedelta(days=2), 1200)
        log_session(self.db, ME, "10:1", self.NOW - timedelta(days=1), 600)
        log_session(self.db, ME, "11:1", self.NOW - timedelta(hours=2), 300)
        self.assertEqual(self.stats()["top_authors"], [{"name": "J. R. R. Tolkien", "ms": 1_200_000},
                                                        {"name": "Frank Herbert", "ms": 900_000}])

    def test_everything_is_the_callers_own(self):
        log_session(self.db, OTHER, "14:1", self.NOW - timedelta(days=1), 600)
        place(self.db, OTHER, "14:1", self.NOW, book_ms=100, duration=100)
        body = self.stats()
        self.assertEqual((body["listened_ms_6mo"], body["listened_ms_all"], body["finished"], body["streak_days"],
                          body["top_authors"]), (0, 0, 0, 0, []))
        self.as_user({"user_id": "", "username": "x", "auth_method": "oidc"})
        self.assertEqual(self.get("/api/books/me/stats").status_code, 403)

    def test_reading_through_the_callers_own_link(self):
        with mock.patch.object(kavita, "reading_stats",
                               mock.AsyncMock(return_value={"pages": 120, "words": 40000, "hours": 3})) as read:
            body = self.stats()
            self.assertEqual((body["reading"], body["notes"]), ({"pages": 120, "words": 40000, "hours": 3}, []))
            self.assertEqual(read.await_args.args, ("http://kavita.test:5000", "jwt-1001"))
            read.side_effect = kavita.KavitaTokenRefused("expired")
            body = self.stats()
            self.assertIsNone(body["reading"])
            self.assertEqual(body["notes"], [{"source": "kavita", "reason": "not_connected",
                                              "text": "Connect your ebook library to include reading"}])
            read.side_effect = kavita.KavitaUnavailable("down")
            self.assertEqual(self.stats()["notes"][0]["reason"], "unavailable")
            self.as_user({**A, "kavita_token": ""})                       # never linked
            read.reset_mock()
            body = self.stats()
            self.assertEqual((body["reading"], [n["text"] for n in body["notes"]]),
                             (None, ["Connect your ebook library to include reading"]))
            read.assert_not_awaited()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Rollup(unittest.TestCase):
    NOW = datetime(2026, 9, 28, 12, 0, 0)

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.addCleanup(self.db.close)

    def all_time(self, identity=ME):
        return book_discovery.stats(self.db, identity, now=self.NOW)["listened_ms_all"]

    def test_all_time_is_unchanged_by_the_prune(self):
        for n in range(18):                       # every 20 days for a year, ten minutes each
            log_session(self.db, ME, "14:1", self.NOW - timedelta(days=20 * n, hours=3), 600)
        log_session(self.db, OTHER, "14:1", self.NOW - timedelta(days=300), 600)
        before = self.all_time()
        self.assertEqual(before, 18 * 600_000)
        self.assertGreater(listening.prune_log(self.db, now=self.NOW), 0)
        self.assertEqual(self.all_time(), before)
        self.assertEqual(self.all_time(OTHER), 600_000)
        body = book_discovery.stats(self.db, ME, now=self.NOW)
        self.assertEqual(body["listened_ms_6mo"], 9 * 600_000)            # days 0 to 160
        days = self.db.query(ListeningDaily).filter(ListeningDaily.identity == ME).count()
        self.assertEqual(days, 17, "every complete day; today's session is still in the log only")
        # A day later, the next prune: still the same.
        self.assertEqual(book_discovery.stats(self.db, ME, now=self.NOW + timedelta(days=30))["listened_ms_all"],
                         before)
        listening.prune_log(self.db, now=self.NOW + timedelta(days=30))
        self.assertEqual(book_discovery.stats(self.db, ME, now=self.NOW + timedelta(days=30))["listened_ms_all"],
                         before)

    def test_a_session_across_midnight_is_counted_once(self):
        log_session(self.db, ME, "14:1", datetime(2026, 9, 20, 23, 59, 30), 60)
        self.assertEqual(self.all_time(), 60_000)
        listening.roll_up(self.db, self.NOW)
        rows = {r.day.isoformat(): r.ms for r in self.db.query(ListeningDaily)}
        self.assertEqual(rows, {"2026-09-20": 30_000, "2026-09-21": 30_000})
        self.assertEqual(self.all_time(), 60_000)

    def test_nothing_is_pruned_that_was_not_rolled_up(self):
        log_session(self.db, ME, "14:1", self.NOW - timedelta(days=200), 60)
        with mock.patch.object(listening, "roll_up", side_effect=RuntimeError("no rollup")):
            with self.assertRaises(RuntimeError):
                listening.prune_log(self.db, now=self.NOW)
        self.db.rollback()
        self.assertEqual(self.db.query(ListeningLog).count(), 7)
        # A rollup that stopped short of the cutoff (April 1) keeps the days after it.
        helpers.put(self.db, listening.ROLLED_THROUGH_KEY, "2026-01-01")
        log_session(self.db, ME, "14:1", datetime(2025, 12, 20, 8), 60)
        log_session(self.db, ME, "14:1", datetime(2026, 1, 5, 8), 60)
        with mock.patch.object(listening, "roll_up", return_value=0):
            self.assertEqual(listening.prune_log(self.db, now=self.NOW), 7)       # December only
        self.assertEqual(self.db.query(ListeningLog).filter(ListeningLog.at < datetime(2026, 4, 1)).count(), 14)

    def test_the_marker_is_not_an_operator_setting(self):
        from app import settings_registry as reg
        self.assertIsNone(reg.get_def(listening.ROLLED_THROUGH_KEY))
        self.assertIsNone(reg.get_def(book_discovery.ANNOUNCE_BASELINE_KEY))

    def test_two_workers_rolling_up_at_once_count_each_day_once(self):
        from sqlalchemy.orm import sessionmaker

        from app import models  # noqa: F401 - registers the tables
        from app.database import Base, make_engine

        with tempfile.TemporaryDirectory() as tmp:
            engine = make_engine(f"sqlite:///{tmp}/roll.db")
            Base.metadata.create_all(bind=engine)
            Session = sessionmaker(bind=engine, autoflush=False)
            db = Session()
            for n in range(30):
                log_session(db, ME, "14:1", self.NOW - timedelta(days=n + 1), 300)
            db.close()
            barrier, errors = threading.Barrier(2), []

            def worker():
                s = Session()
                try:
                    barrier.wait()
                    listening.roll_up(s, self.NOW)
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)
                finally:
                    s.close()

            threads = [threading.Thread(target=worker) for _ in range(2)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            db = Session()
            total = db.query(ListeningDaily).count(), sum(r.ms for r in db.query(ListeningDaily))
            self.assertEqual(listening.roll_up(db, self.NOW), 0, "nothing left to roll up")
            db.close()
            engine.dispose()
        self.assertEqual(errors, [])
        self.assertEqual(total, (30, 30 * 300_000))


class Follows(DiscoveryBase):
    def following(self, name="Dune"):
        return self.ok("/api/books/series", name=name)["following"]

    def test_follow_and_unfollow_by_hand(self):
        self.assertIs(self.following(), False)
        r = self.send("PUT", "/api/books/series/follow", {"series": "dune"})
        self.assertEqual((r.status_code, r.json()), (200, {"following": True}))
        self.assertIs(self.following(), True)
        self.as_user(B)
        self.assertIs(self.following(), False, "A's follow is A's")
        self.as_user(A)
        r = self.send("DELETE", "/api/books/series/follow", {"series": "Dune"})
        self.assertEqual((r.status_code, r.json()), (200, {"following": False}))
        self.assertIs(self.following(), False)

    def test_writes_check_the_origin_and_the_input(self):
        for method in ("PUT", "DELETE"):
            self.assertEqual(self.send(method, "/api/books/series/follow", {"series": "Dune"}, origin=None).status_code,
                             403)
            self.assertEqual(self.send(method, "/api/books/series/follow", {"series": "Dune"},
                                       origin="https://evil.example").status_code, 403)
            for body in ({}, {"series": ""}, {"series": "x" * 201}, {"series": 5}):
                self.assertEqual(self.send(method, "/api/books/series/follow", body).status_code, 422, body)
        self.assertEqual(self.get("/api/books/series/follow").status_code, 405)

    def test_a_series_the_caller_cannot_see_cannot_be_followed(self):
        self.db.query(Book).filter(Book.id == 5).update({"series": "Hidden Saga"})
        self.db.commit()
        for name in ("Hidden Saga", "No Such Series"):
            self.assertEqual(self.send("PUT", "/api/books/series/follow", {"series": name}).status_code, 404)
        self.assertEqual(self.db.query(BookFollow).count(), 0)

    def test_my_list_and_listening_follow(self):
        self.send("PUT", "/api/books/2/list")
        self.assertIs(self.following(), True)
        self.as_user(B)
        place(self.db, OTHER, "10:1", self.now, book_ms=book_discovery.LISTENER_MS - 1, duration=10 ** 8)
        self.assertIs(self.following(), False, "a mis-tap is not following")
        self.db.query(ListeningPosition).update({"book_ms": book_discovery.LISTENER_MS})
        self.db.commit()
        self.assertIs(self.following(), True)

    def test_an_unfollow_stands_against_the_list_until_followed_again(self):
        self.send("PUT", "/api/books/2/list")
        self.send("DELETE", "/api/books/series/follow", {"series": "Dune"})
        self.assertIs(self.following(), False)
        self.send("PUT", "/api/books/series/follow", {"series": "Dune"})
        self.assertIs(self.following(), True)

    def test_reading_in_the_continue_row_follows(self):
        self.in_progress.return_value = [1102]                         # Dune Messiah's Kavita series
        self.places.return_value = {102: kplace(3, 100, when(30), 102)}
        self.assertEqual(len(self.ok("/api/books/continue")["items"]), 1)
        rows = [(f.identity, f.series, f.source) for f in self.db.query(BookFollow)]
        self.assertEqual(rows, [(ME, "dune", "read")])
        self.assertIs(self.following(), True)
        self.send("DELETE", "/api/books/series/follow", {"series": "Dune"})
        self.ok("/api/books/continue")
        self.assertIs(self.following(), False, "reading again does not undo an Unfollow")

    def test_a_follow_failure_never_breaks_the_continue_row(self):
        from sqlalchemy.exc import OperationalError
        self.in_progress.return_value = [1102]
        self.places.return_value = {102: kplace(3, 100, when(30), 102)}
        with mock.patch.object(book_discovery, "note_reading", side_effect=OperationalError("x", {}, Exception())):
            self.assertEqual(len(self.ok("/api/books/continue")["items"]), 1)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Announce(CatalogCase):
    NOW = datetime(2026, 10, 4, 12, 0, 0)

    def setUp(self):
        super().setUp()
        self.push = mock.AsyncMock(return_value=1)
        for p in (mock.patch.object(book_discovery, "_now", lambda: self.NOW),
                  mock.patch.object(book_discovery, "send_push_to_users", self.push)):
            p.start()
            self.addCleanup(p.stop)

    def saga(self, n, title=None, days_ago=1, series="Saga"):
        return ebook(500 + int(n * 10), title or f"Saga Book {n}", series=series, series_number=n,
                     added_at=self.NOW - timedelta(days=days_ago))

    def ids(self):
        db = self.db()
        try:
            return {b.title: b.id for b in db.query(Book).filter(Book.merged_into.is_(None))}
        finally:
            db.close()

    def add(self, *rows):
        db = self.db()
        try:
            db.add_all(rows)
            db.commit()
        finally:
            db.close()

    def person(self, identity, email=None, listed=None, follow=None, books_off=False):
        rows = [BookVisit(identity=identity, email=email, seen_at=self.NOW)]
        if listed:
            rows.append(BookListEntry(identity=identity, book_id=self.ids()[listed], added_at=self.NOW))
        if follow:
            rows.append(BookFollow(identity=identity, series="saga", source=follow, created_at=self.NOW))
        if books_off:
            rows.append(Setting(key=f"notify.{_email_hash(email)}.books", value="false"))
        self.add(*rows)

    def notes(self):
        db = self.db()
        try:
            return sorted((n.user_email, n.category, n.title, n.body) for n in db.query(Notification))
        finally:
            db.close()

    def test_a_burst_is_one_notification_per_follower_per_series(self):
        self.sources.ebooks = [self.saga(1), self.saga(2), ebook(900, "Other 1", series="Other", series_number=1,
                                                                added_at=self.NOW)]
        self.person("plex:9", email="early@example.com", follow="manual")
        self.rebuild()                                     # a fresh database: the first catalog is never news
        self.assertEqual(self.notes(), [])
        self.person("plex:1", email="A@Example.com", listed="Saga Book 2")
        self.person("plex:2", email="b@example.com", follow="manual")
        self.person("plex:3", follow="read")                                         # no email recorded
        self.person("plex:4", email="d@example.com", listed="Saga Book 1", follow="off")
        self.person("plex:5", email="e@example.com", listed="Saga Book 1", books_off=True)
        self.person("plex:6", email="f@example.com")                                 # follows nothing
        self.sources.ebooks += [self.saga(n) for n in range(3, 10)]                  # seven at once
        self.sources.ebooks += [ebook(950, "Saga Extra", series="Saga", added_at=self.NOW),   # unnumbered
                                ebook(901, "Other 2", series="Other", series_number=2, added_at=self.NOW)]
        self.assertTrue(self.rebuild()["ok"])
        expected = [(e, "books", "New in Saga", "7 new books")
                    for e in ("a@example.com", "b@example.com", "early@example.com")]
        self.assertEqual(self.notes(), expected)
        self.push.assert_awaited_once()
        emails, title, body, category = self.push.await_args.args
        self.assertEqual((sorted(emails), title, body, category),
                         (["a@example.com", "b@example.com", "early@example.com"], "New in Saga", "7 new books",
                          "books"))
        self.assertEqual(self.push.await_args.kwargs, {"url": "/books/series?name=Saga"})
        self.rebuild()                                     # nothing new: nothing more
        self.assertEqual(self.notes(), expected)
        self.push.assert_awaited_once()

    def test_only_books_past_the_one_reached(self):
        self.sources.ebooks = [self.saga(1), self.saga(2), self.saga(5)]
        self.rebuild()
        self.person("plex:1", email="a@example.com", listed="Saga Book 5")
        self.person("plex:2", email="b@example.com", listed="Saga Book 1")
        self.sources.ebooks += [self.saga(3), self.saga(4), self.saga(6)]
        self.rebuild()
        self.assertEqual(self.notes(), [("a@example.com", "books", "New in Saga", "1 new book"),
                                        ("b@example.com", "books", "New in Saga", "3 new books")])

    def test_old_and_unnumbered_books_are_passed_over(self):
        self.sources.ebooks = [self.saga(1)]
        self.rebuild()
        self.person("plex:1", email="a@example.com", follow="manual")
        self.sources.ebooks += [self.saga(2, days_ago=31), ebook(950, "Saga Extra", series="Saga",
                                                                 added_at=self.NOW)]
        self.rebuild()
        self.assertEqual(self.notes(), [])
        db = self.db()
        try:
            self.assertEqual(db.query(BookAnnounced).count(), 3, "both are dealt with, silently")
        finally:
            db.close()

    def test_a_failed_push_or_announce_never_fails_the_rebuild(self):
        self.sources.ebooks = [self.saga(1)]
        self.rebuild()
        self.person("plex:1", email="a@example.com", follow="manual")
        self.push.side_effect = RuntimeError("push service down")
        self.sources.ebooks += [self.saga(2)]
        self.assertTrue(self.rebuild()["ok"])
        self.assertEqual(len(self.notes()), 1, "the notification is kept")
        self.sources.ebooks += [self.saga(3)]
        with mock.patch.object(book_discovery, "_announce", side_effect=RuntimeError("db")):
            result = self.rebuild()
        self.assertEqual((result["ok"], result["books"]), (True, 3))

    def test_the_marks_of_books_that_left_are_dropped(self):
        self.sources.ebooks = [self.saga(1), self.saga(2)]
        self.rebuild()
        gone = self.ids()["Saga Book 2"]
        self.sources.ebooks = [self.saga(1)]
        self.rebuild()
        db = self.db()
        try:
            self.assertIsNone(db.get(BookAnnounced, gone))
        finally:
            db.close()

    def test_two_workers_announce_a_burst_once(self):
        from sqlalchemy.orm import sessionmaker

        from app import models  # noqa: F401 - registers the tables
        from app.database import Base, make_engine

        with tempfile.TemporaryDirectory() as tmp:
            engine = make_engine(f"sqlite:///{tmp}/announce.db")
            Base.metadata.create_all(bind=engine)
            Session = sessionmaker(bind=engine, autoflush=False)
            db = Session()
            db.add(Setting(key=book_discovery.ANNOUNCE_BASELINE_KEY, value="x"))
            db.add(BookVisit(identity="plex:1", email="a@example.com", seen_at=self.NOW))
            db.add(BookFollow(identity="plex:1", series="saga", source="manual", created_at=self.NOW))
            for n in range(1, 8):                     # seven books in one second
                db.add(Book(id=n, title=f"Saga {n}", sort_title="", author="", series="Saga", series_number=n,
                            description="", ebook_added_at=self.NOW, added_at=self.NOW, updated_at=self.NOW,
                            cover_source="kavita"))
            db.commit()
            db.close()
            barrier, results, errors = threading.Barrier(2), [], []

            def worker():
                try:
                    barrier.wait()
                    results.append(book_discovery._announce(Session, self.NOW))
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

            threads = [threading.Thread(target=worker) for _ in range(2)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            db = Session()
            rows = [(n.user_email, n.body) for n in db.query(Notification)]
            db.close()
            engine.dispose()
        self.assertEqual(errors, [])
        self.assertEqual(rows, [("a@example.com", "7 new books")])
        self.assertEqual(sorted(len(r) for r in results), [0, 1], "one pass found them, the other nothing")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Seeding(CatalogCase):
    NOW = datetime(2026, 10, 4, 12, 0, 0)

    def setUp(self):
        super().setUp()
        self.push = mock.AsyncMock(return_value=1)
        for p in (mock.patch.object(book_discovery, "_now", lambda: self.NOW),
                  mock.patch.object(book_discovery, "send_push_to_users", self.push)):
            p.start()
            self.addCleanup(p.stop)

    def test_the_books_there_at_deploy_are_never_announced(self):
        from app import seed
        with mock.patch.object(book_discovery, "announce", mock.AsyncMock(return_value=0)):
            self.sources.ebooks = [ebook(500 + n, f"Saga {n}", series="Saga", series_number=n,
                                         added_at=self.NOW) for n in range(1, 23)]
            self.rebuild()                              # the catalog as it stood before this release
        db = self.db()
        try:
            db.add(BookVisit(identity="plex:1", email="a@example.com", seen_at=self.NOW))
            db.add(BookFollow(identity="plex:1", series="saga", source="manual", created_at=self.NOW))
            db.commit()
            seed.migrate_book_announced(db)
            seed.migrate_book_announced(db)             # a second start changes nothing
            self.assertEqual(db.query(BookAnnounced).count(), 22)
            self.assertIsNotNone(db.query(Setting).filter(Setting.key == book_discovery.ANNOUNCE_BASELINE_KEY).first())
        finally:
            db.close()
        self.rebuild()                                  # the first rebuild after the deploy
        self.assertEqual(self.push.await_count, 0)
        self.sources.ebooks.append(ebook(600, "Saga 23", series="Saga", series_number=23, added_at=self.NOW))
        self.rebuild()
        self.assertEqual(self.push.await_args.args[1:3], ("New in Saga", "1 new book"))

    def test_a_fresh_database_seeds_nothing_and_its_first_catalog_is_silent(self):
        from app import seed
        db = self.db()
        try:
            seed.migrate_book_announced(db)
            self.assertEqual(db.query(BookAnnounced).count(), 0)
            self.assertIsNone(db.query(Setting).filter(Setting.key == book_discovery.ANNOUNCE_BASELINE_KEY).first())
            db.add(BookVisit(identity="plex:1", email="a@example.com", seen_at=self.NOW))
            db.add(BookFollow(identity="plex:1", series="saga", source="manual", created_at=self.NOW))
            db.commit()
        finally:
            db.close()
        self.sources.ebooks = [ebook(500 + n, f"Saga {n}", series="Saga", series_number=n,
                                     added_at=self.NOW) for n in range(1, 23)]
        self.rebuild()
        self.assertEqual(self.push.await_count, 0)

    def test_a_rebuild_that_read_nothing_sets_no_baseline(self):
        self.sources.kavita_down = self.sources.plex_down = True
        self.rebuild()
        self.sources.kavita_down = self.sources.plex_down = False
        db = self.db()
        try:
            self.assertIsNone(db.query(Setting).filter(Setting.key == book_discovery.ANNOUNCE_BASELINE_KEY).first())
        finally:
            db.close()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Preference(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        with mock.patch("app.routers.setup.is_setup_completed", return_value=True):
            self.client = helpers.api_client(self.Session, helpers.MEMBER)
        self.addCleanup(helpers.reset_overrides)

    def test_books_can_be_turned_off_and_is_on_by_default(self):
        from app.services.notification_poller import _user_wants_category
        db = self.Session()
        try:
            self.assertTrue(_user_wants_category(db, "sam@example.com", "books"))
        finally:
            db.close()
        with mock.patch("app.routers.setup.is_setup_completed", return_value=True):
            r = self.client.put("/api/notifications/preferences", json={"books": False})
        self.assertEqual(r.status_code, 200, r.text)
        db = self.Session()
        try:
            self.assertFalse(_user_wants_category(db, "sam@example.com", "books"))
            self.assertEqual(helpers.get(db, f"notify.{_email_hash('sam@example.com')}.books"), "false")
        finally:
            db.close()

    def test_the_preferences_modal_is_told_about_books(self):
        # 3c Task 2: "books" is a listed category, so GET returns it and the modal shows its switch.
        with mock.patch("app.routers.setup.is_setup_completed", return_value=True):
            r = self.client.get("/api/notifications/preferences")
            self.assertEqual(r.status_code, 200, r.text)
            self.assertIs(r.json().get("books"), True)
            self.client.put("/api/notifications/preferences", json={"books": False})
            self.assertIs(self.client.get("/api/notifications/preferences").json().get("books"), False)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Integrations(unittest.TestCase):
    def test_kavita_reading_stats_ask_for_the_callers_own_id(self):
        seen = []

        def answer(request):
            seen.append((request.url.path, dict(request.url.params), request.headers.get("authorization")))
            if request.url.path == "/api/Account":
                return httpx.Response(200, json={"id": 7, "username": "sam", "apiKey": "never-read"})
            return httpx.Response(200, json={"totalPagesRead": 320, "totalWordsRead": 81000, "timeSpentReading": 9,
                                             "avgHoursPerWeekSpentReading": 1.5})

        client = httpx.AsyncClient(transport=httpx.MockTransport(answer))
        with mock.patch.object(kavita, "_user_client", return_value=client):
            got = asyncio.run(kavita.reading_stats("http://kavita.test", "jwt-7"))
        self.assertEqual(got, {"pages": 320, "words": 81000, "hours": 9})
        self.assertEqual(seen, [("/api/Account", {}, "Bearer jwt-7"),
                                ("/api/Stats/user-read", {"userId": "7"}, "Bearer jwt-7")])

    def test_kavita_reading_stats_refusals(self):
        for status, error in ((401, kavita.KavitaTokenRefused), (500, kavita.KavitaUnavailable)):
            client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r, s=status: httpx.Response(s)))
            with self.subTest(status=status), mock.patch.object(kavita, "_user_client", return_value=client):
                with self.assertRaises(error):
                    asyncio.run(kavita.reading_stats("http://kavita.test", "jwt-7"))
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"id": "7"})))
        with mock.patch.object(kavita, "_user_client", return_value=client):
            with self.assertRaises(kavita.KavitaUnavailable):
                asyncio.run(kavita.reading_stats("http://kavita.test", "jwt-7"))

    def test_plex_history_pages_until_the_plays_are_older(self):
        since = datetime(2026, 9, 1)
        floor = int(since.replace(tzinfo=timezone.utc).timestamp())
        pages = []

        def answer(request):
            start = int(request.url.params["X-Plex-Container-Start"])
            pages.append((start, request.url.params["librarySectionID"], request.headers.get("x-plex-token")))
            if start == 0:
                items = [{"type": "track", "accountID": 1, "parentRatingKey": "100", "parentIndex": 2,
                          "viewedAt": floor + 50}] * 2 + [
                         {"type": "episode", "accountID": 3, "parentRatingKey": "7", "viewedAt": floor + 40},
                         {"type": "track", "accountID": 4, "parentRatingKey": "200", "viewedAt": floor + 30}]
                items += [{"type": "track", "accountID": 5, "parentRatingKey": "300", "viewedAt": floor + 10}] * 496
                return httpx.Response(200, json={"MediaContainer": {"Metadata": items}})
            return httpx.Response(200, json={"MediaContainer": {"Metadata": [
                {"type": "track", "accountID": 6, "parentRatingKey": "400", "viewedAt": floor},
                {"type": "track", "accountID": 7, "parentRatingKey": "500", "viewedAt": floor - 1}]}})

        client = httpx.AsyncClient(transport=httpx.MockTransport(answer), base_url="http://plex.test")
        admin = {"url": "http://plex.test", "token": "ADMIN", "section": "12"}
        with mock.patch.object(pp, "_admin", return_value=admin), \
                mock.patch.object(pp, "_pms_client", return_value=client):
            plays = asyncio.run(pp.play_history(since))
        self.assertEqual(pages, [(0, "12", "ADMIN"), (500, "12", "ADMIN")])
        self.assertEqual(plays[:3], [("1", "100:2"), ("1", "100:2"), ("4", "200:1")])
        self.assertEqual(plays[-1], ("6", "400:1"))
        self.assertEqual(len(plays), 3 + 496 + 1)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Migration(unittest.TestCase):
    def test_two_workers_starting_at_once_add_the_tables_and_seed_the_announced_books(self):
        from app import models  # noqa: F401 - registers the tables
        from app.database import Base, make_engine

        new_tables = {"book_visits", "book_popularity", "listening_daily", "book_follows", "book_announced"}
        with tempfile.TemporaryDirectory() as tmp:
            url = f"sqlite:///{tmp}/old.db"
            engine = make_engine(url)
            Base.metadata.create_all(bind=engine, tables=[t for t in Base.metadata.sorted_tables
                                                          if t.name not in new_tables])
            with engine.begin() as conn:
                for book_id in (4, 9):
                    conn.execute(text("INSERT INTO books (id, title, sort_title, author, series, description, "
                                      "cover_source, updated_at) VALUES (:id, 'Kept', '', '', '', '', 'plex', "
                                      "'2026-01-01 00:00:00')"), {"id": book_id})
            self.assertFalse(new_tables & set(inspect(engine).get_table_names()))
            self.assertEqual(run_together([STARTUP_CHILD, STARTUP_CHILD], url), ["started", "started"])
            run_together([STARTUP_CHILD], url)
            self.assertTrue(new_tables <= set(inspect(engine).get_table_names()))
            uniques = {t: {tuple(u["column_names"]) for u in inspect(engine).get_unique_constraints(t)}
                       for t in ("listening_daily", "book_follows")}
            with engine.connect() as conn:
                announced = sorted(r[0] for r in conn.execute(text("SELECT book_id FROM book_announced")))
                markers = sorted(r[0] for r in conn.execute(text(
                    "SELECT key FROM settings WHERE key IN ('migration.book_announced_v1', 'books.announce_baseline')")))
            engine.dispose()
        self.assertEqual(announced, [4, 9])
        self.assertEqual(markers, ["books.announce_baseline", "migration.book_announced_v1"])
        self.assertIn(("identity", "day"), uniques["listening_daily"])
        self.assertIn(("identity", "series"), uniques["book_follows"])


if __name__ == "__main__":
    unittest.main()
