"""
Insights tracking, the listening half (docs/superpowers/specs/2026-10-10-insights-design.md,
sections 4.1 and 5): every check-in's log row says where it came from, and
the log is rolled up by person, hour, book and source into listening_hourly,
which outlives the log's 180 days.
"""
import asyncio
import logging
import unittest
from datetime import datetime, timedelta
from unittest import mock

try:
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False
if HAVE_APP:
    from app.models import ListeningHourly, ListeningLog, Setting
    from app.services import listening
    from app.utils import utc_iso

ME = "plex:1001"
THEM = "plex:2002"
NOW = datetime(2026, 10, 10, 12, 30)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Base(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.addCleanup(self.db.close)

    def log(self, at, event="checkin", identity=ME, book="5:1", source="web"):
        self.db.add(ListeningLog(identity=identity, book_key=book, track_key="6", offset_ms=0,
                                 event=event, at=at, source=source))
        self.db.commit()

    def play(self, start, seconds, **kw):
        """Check-ins every 10 s from `start` for `seconds`, then a pause."""
        for s in range(0, seconds, 10):
            self.log(start + timedelta(seconds=s), "play" if s == 0 else "checkin", **kw)
        self.log(start + timedelta(seconds=seconds), "pause", **kw)

    def hours(self):
        return sorted((r.identity, r.hour, r.book_key, r.source, r.ms) for r in self.db.query(ListeningHourly))


class LogSource(Base):
    def test_a_checkin_logs_where_it_came_from(self):
        first = listening.save_checkin(self.db, ME, "5:1", "6", 1000, 60000, "play", "Chrome", "p1", 1)
        self.assertTrue(first["stored"])
        # Another page session that saw nothing: a conflict, logged all the same.
        second = listening.save_checkin(self.db, ME, "5:1", "6", 2000, 60000, "checkin", "Phone", "p2", 1,
                                        source="local")
        self.assertIn("conflict", second)
        sources = [s for (s,) in self.db.query(ListeningLog.source).order_by(ListeningLog.id)]
        self.assertEqual(sources, ["web", "local"])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Migration(unittest.TestCase):
    def test_existing_rows_become_web_once(self):
        from sqlalchemy import create_engine, text
        from sqlalchemy.orm import sessionmaker
        from sqlalchemy.pool import StaticPool
        from app.seed import migrate_listening_log_source

        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        with engine.begin() as conn:
            conn.execute(text("CREATE TABLE listening_log (id INTEGER PRIMARY KEY, identity VARCHAR(255) NOT NULL, "
                              "book_key VARCHAR(64) NOT NULL, track_key VARCHAR(64) NOT NULL, "
                              "offset_ms INTEGER NOT NULL, device VARCHAR(80) NOT NULL, "
                              "event VARCHAR(16) NOT NULL, at DATETIME NOT NULL)"))
            conn.execute(text("INSERT INTO listening_log (identity, book_key, track_key, offset_ms, device, event, at) "
                              "VALUES ('plex:1', '5:1', '6', 10, 'd', 'pause', '2026-09-01 00:00:00')"))
        db = sessionmaker(bind=engine)()
        try:
            with self.assertLogs("app.seed", level=logging.INFO):
                migrate_listening_log_source(db)
            with self.assertNoLogs("app.seed", level=logging.INFO):
                migrate_listening_log_source(db)    # idempotent
            self.assertEqual(db.execute(text("SELECT source FROM listening_log")).scalar(), "web")
        finally:
            db.close()

    def test_a_fresh_database_needs_nothing(self):
        from app.seed import migrate_listening_log_source
        db = helpers.make_sessionmaker()()
        try:
            with self.assertNoLogs("app.seed", level=logging.INFO):
                migrate_listening_log_source(db)
        finally:
            db.close()


class HourlyRollup(Base):
    def test_the_first_pass_rolls_up_the_whole_log_by_hour_book_and_source(self):
        self.play(datetime(2026, 9, 1, 9, 0), 60)                  # 60 s in the 09:00 hour
        self.play(datetime(2026, 9, 1, 9, 59, 50), 30)             # 10 s at 09:59:50, 20 s after 10:00
        self.play(datetime(2026, 9, 1, 10, 30), 20, identity=THEM, book="7:1", source="plex")
        written = listening.roll_up_hours(self.db, NOW)
        h9, h10 = datetime(2026, 9, 1, 9), datetime(2026, 9, 1, 10)
        self.assertEqual(self.hours(), [(ME, h9, "5:1", "web", 70000), (ME, h10, "5:1", "web", 20000),
                                        (THEM, h10, "7:1", "plex", 20000)])
        self.assertEqual(written, 3)
        self.assertEqual(listening.hours_through(self.db), datetime(2026, 10, 10, 12))

    def test_the_current_hour_waits_until_it_is_over(self):
        self.play(NOW - timedelta(minutes=10), 30)                 # 12:20, the hour is not over
        listening.roll_up_hours(self.db, NOW)
        self.assertEqual(self.hours(), [])
        listening.roll_up_hours(self.db, NOW + timedelta(hours=1))
        self.assertEqual([r[4] for r in self.hours()], [30000])

    def test_a_late_row_in_the_last_two_days_changes_its_hour(self):
        self.play(datetime(2026, 10, 9, 8, 0), 20)
        listening.roll_up_hours(self.db, NOW)
        # A phone that was offline sends its 08:10 check-ins now.
        self.play(datetime(2026, 10, 9, 8, 10), 20)
        listening.roll_up_hours(self.db, NOW + timedelta(minutes=5))
        self.assertEqual([r[4] for r in self.hours()], [40000])

    def test_an_hour_older_than_two_days_is_final(self):
        self.play(datetime(2026, 10, 1, 8, 0), 20)
        listening.roll_up_hours(self.db, NOW)
        self.play(datetime(2026, 10, 1, 8, 10), 20)
        listening.roll_up_hours(self.db, NOW + timedelta(minutes=5))
        self.assertEqual([r[4] for r in self.hours()], [20000])

    def test_running_twice_changes_nothing(self):
        self.play(datetime(2026, 10, 9, 8, 0), 20)
        listening.roll_up_hours(self.db, NOW)
        before = self.hours()
        listening.roll_up_hours(self.db, NOW)
        self.assertEqual(self.hours(), before)

    def test_two_devices_at_once_count_once(self):
        # As Your stats: the gaps are between the listener's rows, whatever the book.
        start = datetime(2026, 9, 1, 9, 0)
        for s in range(0, 60, 10):
            self.log(start + timedelta(seconds=s), book="5:1")
            self.log(start + timedelta(seconds=s + 5), book="8:1")
        listening.roll_up_hours(self.db, NOW)
        self.assertEqual(sum(r[4] for r in self.hours()), 55000)

    def test_an_empty_log_writes_nothing_and_sets_no_marker(self):
        self.assertEqual(listening.roll_up_hours(self.db, NOW), 0)
        self.assertIsNone(listening.hours_through(self.db))


class Prune(Base):
    def test_the_log_is_never_pruned_past_what_the_hours_hold(self):
        old = NOW - timedelta(days=listening.LOG_DAYS + 3)
        self.play(old, 20)
        # A rollup that has been failing: its marker is still before the old rows.
        self.db.add(Setting(key=listening.HOURS_THROUGH_KEY, value=utc_iso(old - timedelta(days=1))))
        self.db.commit()
        with mock.patch.object(listening, "roll_up_hours"):
            listening.prune_log(self.db, NOW)
        self.assertEqual(self.db.query(ListeningLog).count(), 3)

    def test_hours_older_than_two_years_go(self):
        for days, ms in ((731, 1), (729, 2)):
            self.db.add(ListeningHourly(identity=ME, hour=NOW - timedelta(days=days), book_key="5:1",
                                        source="web", ms=ms))
        self.db.commit()
        listening.prune_log(self.db, NOW)
        self.assertEqual([r[4] for r in self.hours()], [2])


class Refresh(Base):
    def test_the_hourly_books_pass_rolls_up_hours(self):
        from app.services import book_discovery
        with mock.patch.object(book_discovery.pp, "play_history",
                               mock.AsyncMock(side_effect=book_discovery.pp.PlayerOff("off"))), \
                mock.patch.object(book_discovery, "SessionLocal", self.Session), \
                mock.patch.object(listening, "roll_up_hours") as hours:
            asyncio.run(book_discovery.refresh(NOW))
        hours.assert_called_once()


if __name__ == "__main__":
    unittest.main()
