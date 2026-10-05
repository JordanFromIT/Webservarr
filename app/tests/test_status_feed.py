"""
The status feed (v2 step 5, Task 1): outages from Uptime Kuma and admins'
notes (app/services/status_feed.py), detected by the notification poller,
served by app/routers/status.py, and the one-line public status summary.

Review Focus covered here:
  1. A monitor that flaps opens no outage; an outage is posted and pushed
     exactly once across 2 workers.
  2. With Uptime Kuma not answering, nothing claims everything is running.
  3. The public status summary reveals only the one-line current state.

Uptime Kuma is faked at read_monitors (its parsing is tested in
test_notification_poller's StatusSinceTests), Redis by test_notification_poller's
FakeRedis and pushes at send_push_to_users. The two-worker cases run on a real
SQLite file with two connections, or as two real processes for the migration.
"""
import asyncio
import logging
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest import mock

from app.tests import helpers

try:
    import httpx  # noqa: F401 - only present with the app's dependencies
    from sqlalchemy import text
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

if HAVE_APP:
    # Not in the guard above: a missing module of this work must fail the suite, not skip it.
    from sqlalchemy.exc import IntegrityError, OperationalError
    from sqlalchemy.orm import Session as SASession, sessionmaker

    from app.models import Notification, PushSubscription, Setting, StatusUpdate
    from app.routers.notifications import NOTIFICATION_CATEGORIES, _email_hash
    from app.services import notification_poller as poller
    from app.services import status_feed
    from app.tests.test_book_catalog import STARTUP_CHILD, run_together
    from app.tests.test_notification_poller import FakeRedis

T0 = datetime(2026, 10, 1, 12, 0, 0)
ORIGIN = "https://localhost"
KUMA_URL = "http://kuma.test:3001"
OWNER = "owner@example.com"


def run(coro):
    return asyncio.run(coro)


def kuma_time(dt):
    """A heartbeat time as Uptime Kuma sends it (UTC, no zone)."""
    return dt.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def signed_up(case):
    """The setup redirect (main.py) reads the real database, which CI does not have."""
    p = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
    p.start()
    case.addCleanup(p.stop)


def add_row(Session, **fields):
    values = dict(title="t", message="t", update_type="note", severity="info", author_id="",
                  author_name="", active=True, source="admin", important=False, created_at=T0)
    values.update(fields)
    if "message" in fields and "title" not in fields:
        values["title"] = fields["message"][:200]
    db = Session()
    try:
        row = StatusUpdate(**values)
        db.add(row)
        db.commit()
        return row.id
    finally:
        db.close()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class FeedCase(unittest.TestCase):
    """The poller on an in-memory database, a fake Redis and a fake clock."""

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.r = FakeRedis()
        self.now = T0
        self.pushed = []

        async def fake_push(emails, title, body, category, url="/"):
            self.pushed.append((sorted(emails), title, body, category, url))
            return len(emails)

        for p in (mock.patch.object(poller, "SessionLocal", self.Session),
                  mock.patch.object(poller, "send_push_to_users", fake_push),
                  mock.patch.object(status_feed, "now_utc", lambda: self.now)):
            p.start()
            self.addCleanup(p.stop)

    def subscribe(self, email):
        db = self.Session()
        try:
            db.add(PushSubscription(user_email=email, endpoint=f"https://push.example.com/{email}",
                                    p256dh="p", auth="a"))
            db.commit()
        finally:
            db.close()

    def poll(self, status=None, since=None, minutes=1, monitors=None, answered=True):
        """One monitor poll `minutes` after the last, then the push sweep the
        poller runs on every tick."""
        self.now += timedelta(minutes=minutes)
        if monitors is None:
            monitors = [{"id": 7, "name": "Media", "status": status, "status_since": since}]
        with mock.patch("app.integrations.uptime_kuma.read_monitors",
                        mock.AsyncMock(return_value=monitors if answered else None)):
            run(poller._poll_monitors(self.r))
        run(poller.push_status_updates(self.r))

    def go_down(self):
        """Up, then down for two polls (12:01, 12:02, 12:03): the outage opens, begun 12:02."""
        self.poll("up", kuma_time(T0))
        self.poll("down", kuma_time(T0 + timedelta(minutes=2)))
        self.poll("down", kuma_time(T0 + timedelta(minutes=2)))

    def rows(self):
        db = self.Session()
        try:
            return db.query(StatusUpdate).order_by(StatusUpdate.id).all()
        finally:
            db.close()

    def notifications(self):
        db = self.Session()
        try:
            return [(n.user_email, n.category, n.title, n.reference_id)
                    for n in db.query(Notification).order_by(Notification.id).all()]
        finally:
            db.close()


class Outages(FeedCase):
    def test_an_outage_opens_on_the_second_poll_that_finds_it_down(self):
        self.poll("up", kuma_time(T0))
        self.poll("down", kuma_time(T0 + timedelta(minutes=2)))
        self.assertEqual(self.rows(), [], "one down poll opens nothing")
        self.poll("down", kuma_time(T0 + timedelta(minutes=2)))
        [row] = self.rows()
        self.assertEqual((row.source, row.message, row.service_name, row.monitor_id, row.active),
                         ("auto", "Media is down", "Media", 7, True))
        self.assertEqual(row.started_at, T0 + timedelta(minutes=2))
        self.poll("down")
        self.poll("down")
        self.assertEqual(len(self.rows()), 1, "still down: still one outage")

    def test_a_monitor_that_flaps_opens_nothing(self):
        # Review Focus 1: down, up, down within two polls never opens one.
        self.subscribe(OWNER)
        for status in ("up", "down", "up", "down", "up", "down", "up"):
            self.poll(status, kuma_time(self.now))
        self.poll("up", minutes=20)
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.pushed, [])
        self.assertEqual(self.notifications(), [])

    def test_back_up_closes_it_with_how_long_it_was_down(self):
        self.go_down()
        self.poll("up", kuma_time(T0 + timedelta(minutes=8)), minutes=5)
        [row] = self.rows()
        self.assertFalse(row.active)
        self.assertEqual(row.message, "Media is back, down 6 min")
        self.assertEqual((row.ended_at, row.update_type), (T0 + timedelta(minutes=8), "resolved"))
        self.assertEqual(self.pushed, [], "back within 10 minutes: never pushed")
        # A later outage of the same monitor is a new one.
        self.poll("down", kuma_time(self.now + timedelta(minutes=1)))
        self.poll("down")
        self.assertEqual([r.active for r in self.rows()], [False, True])

    def test_an_empty_redis_never_opens_on_the_first_poll(self):
        # A full restart empties Redis: the first poll only records.
        self.poll("down", kuma_time(T0))
        self.assertEqual(self.rows(), [])
        self.poll("down", kuma_time(T0))
        self.assertEqual(len(self.rows()), 1)

    def test_a_monitor_switched_off_opens_nothing(self):
        db = self.Session()
        helpers.put(db, "monitor.7.enabled", "false")
        db.close()
        self.go_down()
        self.poll("down", minutes=15)
        self.assertEqual(self.rows(), [])

    def test_an_outage_open_before_a_restart_is_not_opened_twice(self):
        self.go_down()
        self.r.store.clear()                     # Redis emptied by the restart
        self.poll("down")
        self.poll("down")
        self.assertEqual(len(self.rows()), 1)
        self.poll("up", minutes=30)
        self.assertEqual(self.rows()[0].message, "Media is back, down 33 min")   # 12:02 to 12:35

    def test_names_come_from_uptime_kuma(self):
        self.poll(monitors=[{"id": 3, "name": "Audiobooks", "status": "up", "status_since": None}])
        for _ in range(2):
            self.poll(monitors=[{"id": 3, "name": "Audiobooks", "status": "down", "status_since": None}])
        self.assertEqual(self.rows()[0].message, "Audiobooks is down")


class Pushes(FeedCase):
    def test_an_outage_is_pushed_once_when_it_has_lasted_ten_minutes(self):
        self.subscribe(OWNER)
        self.go_down()                                  # began 12:02, now 12:03
        self.poll("down", minutes=8)                    # 12:11: 9 minutes
        self.assertEqual(self.pushed, [])
        self.poll("down")                               # 12:12: 10 minutes
        self.assertEqual(self.pushed, [([OWNER], "Media is down", "Down for 10 min", "status", "/status")])
        row_id = self.rows()[0].id
        self.assertEqual(self.notifications(), [(OWNER, "status", "Media is down", f"status:{row_id}")])
        for _ in range(5):
            self.poll("down", minutes=5)
        self.poll("up")
        self.assertEqual(len(self.pushed), 1)
        self.assertEqual(len(self.notifications()), 1)

    def test_two_workers_post_and_push_it_once(self):
        # Review Focus 1: every poll and every sweep runs twice, as two
        # pollers would during a lease handover, on the same Redis and
        # database. (The race inside one statement: OnceAcrossWorkers.)
        self.subscribe(OWNER)
        self.r.hashes["session:x"] = {"email": "friend@example.com"}
        for status, minutes in (("up", 1), ("down", 1), ("down", 1), ("down", 10), ("down", 1)):
            self.poll(status, kuma_time(T0 + timedelta(minutes=2)), minutes=minutes)
            self.poll(status, kuma_time(T0 + timedelta(minutes=2)), minutes=0)
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(len(self.pushed), 1)
        self.assertEqual(self.pushed[0][0], ["friend@example.com", OWNER])
        self.assertEqual(len(self.notifications()), 2)

    def test_only_people_who_want_status_notifications_get_them(self):
        self.subscribe(OWNER)
        self.subscribe("quiet@example.com")
        db = self.Session()
        helpers.put(db, f"notify.{_email_hash('quiet@example.com')}.status", "false")
        db.close()
        self.go_down()
        self.poll("down", minutes=10)
        self.assertEqual([p[0] for p in self.pushed], [[OWNER]])
        self.assertEqual([n[0] for n in self.notifications()], [OWNER])

    def test_an_important_note_is_pushed_once_and_a_plain_one_never(self):
        self.subscribe(OWNER)
        add_row(self.Session, message="Plex restarts at 9 tonight", important=True)
        add_row(self.Session, message="New shelves on Books")
        add_row(self.Session, message="Already over", important=True, active=False)
        run(poller.push_status_updates(self.r))
        run(poller.push_status_updates(self.r))
        self.assertEqual(self.pushed, [([OWNER], "Status update", "Plex restarts at 9 tonight", "status",
                                        "/status")])

    def test_uptime_kuma_not_answering(self):
        # Review Focus 2: nothing opens or closes on no answer, the feed is
        # told, an outage is never pushed on a stale reading, and notes
        # still are.
        self.subscribe(OWNER)
        self.go_down()
        self.assertIn(status_feed.KUMA_OK_KEY, self.r.store)
        self.assertEqual(self.r.expiry[status_feed.KUMA_OK_KEY], self.r.now + 3 * 60)
        self.poll(answered=False, minutes=15)
        self.assertNotIn(status_feed.KUMA_OK_KEY, self.r.store)
        [row] = self.rows()
        self.assertTrue(row.active, "no answer is not 'back up'")
        self.assertEqual(self.pushed, [])
        add_row(self.Session, message="Looking into it", important=True)
        self.poll(answered=False)
        self.assertEqual([p[1] for p in self.pushed], ["Status update"])
        self.poll("down")                               # Kuma answers again: the outage is due
        self.assertEqual([p[1] for p in self.pushed], ["Status update", "Media is down"])

    def test_one_recipient_failing_does_not_drop_the_others(self):
        for email in ("a@example.com", "b@example.com", "c@example.com"):
            self.subscribe(email)
        add_row(self.Session, message="Maintenance now", important=True)
        real_commit = SASession.commit

        def commit(session):
            if any(isinstance(o, Notification) and o.user_email == "b@example.com" for o in session.new):
                raise OperationalError("INSERT", {}, Exception("disk I/O error"))
            return real_commit(session)

        with mock.patch.object(SASession, "commit", autospec=True, side_effect=commit), \
                self.assertLogs(poller.logger, level="WARNING"):
            run(poller.push_status_updates(self.r))
        self.assertEqual(self.pushed[0][0], ["a@example.com", "c@example.com"])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class OnceAcrossWorkers(unittest.TestCase):
    """The database decides, in one statement, which worker opens an outage
    and which one pushes it: here the other worker does it between this
    one's check and its write."""

    def setUp(self):
        from sqlalchemy import create_engine, event
        from app.database import Base
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        url = f"sqlite:///{os.path.join(tmp.name, 'feed.db')}"
        self.mine = create_engine(url)
        self.other = create_engine(url)
        for engine in (self.mine, self.other):
            self.addCleanup(engine.dispose)
        Base.metadata.create_all(bind=self.mine)
        self.event = event

    def race(self, prefix, other_worker):
        raced = []

        def hook(conn, cursor, statement, parameters, context, executemany):
            if statement.startswith(prefix) and not raced:
                raced.append(statement)
                db2 = sessionmaker(bind=self.other)()
                try:
                    other_worker(db2)
                finally:
                    db2.close()
        self.event.listen(self.mine, "before_cursor_execute", hook)
        self.addCleanup(self.event.remove, self.mine, "before_cursor_execute", hook)
        return raced

    def test_an_outage_opens_once(self):
        raced = self.race("INSERT INTO status_updates",
                          lambda db2: status_feed.open_outage(db2, 7, "Media", T0, T0))
        db = sessionmaker(bind=self.mine)()
        try:
            self.assertIsNone(status_feed.open_outage(db, 7, "Media", T0, T0))
            self.assertEqual(len(raced), 1)
            self.assertEqual(db.query(StatusUpdate).count(), 1)
            # Closed, the next outage of the monitor may open.
            self.assertIsNotNone(status_feed.close_outage(db, 7, T0 + timedelta(minutes=5)))
            self.assertIsNotNone(status_feed.open_outage(db, 7, "Media", T0, T0 + timedelta(minutes=9)))
        finally:
            db.close()

    def test_a_push_is_claimed_once(self):
        db = sessionmaker(bind=self.mine)()
        try:
            row = status_feed.open_outage(db, 7, "Media", T0, T0)
            raced = self.race("UPDATE status_updates SET pushed_at",
                              lambda db2: self.assertTrue(status_feed.claim_push(db2, row.id, T0)))
            self.assertFalse(status_feed.claim_push(db, row.id, T0))
            self.assertEqual(len(raced), 1)
        finally:
            db.close()

    def test_an_outage_closes_once(self):
        db = sessionmaker(bind=self.mine)()
        try:
            status_feed.open_outage(db, 7, "Media", T0, T0)
            raced = self.race("UPDATE status_updates SET",
                              lambda db2: status_feed.close_outage(db2, 7, T0 + timedelta(minutes=3)))
            self.assertIsNone(status_feed.close_outage(db, 7, T0 + timedelta(minutes=4)))
            self.assertEqual(len(raced), 1)
            row = db.query(StatusUpdate).one()
            self.assertEqual(row.message, "Media is back, down 3 min")
        finally:
            db.close()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Words(unittest.TestCase):
    def test_durations(self):
        for seconds, words in ((30, "under a minute"), (60, "1 min"), (59 * 60 + 59, "59 min"),
                               (3600, "1 h"), (3900, "1 h 5 min"), (86400, "1 day"),
                               (2 * 86400 + 3 * 3600 + 120, "2 days 3 h")):
            self.assertEqual(status_feed.duration_text(seconds), words)

    def test_times_from_uptime_kuma_and_the_poller(self):
        fallback = datetime(2000, 1, 1)
        self.assertEqual(status_feed.parse_time("2026-10-01 12:02:00.123", fallback),
                         datetime(2026, 10, 1, 12, 2, 0, 123000))
        self.assertEqual(status_feed.parse_time("2026-10-01T14:02:00+02:00", fallback), datetime(2026, 10, 1, 12, 2))
        for junk in (None, "", "yesterday", 5):
            self.assertEqual(status_feed.parse_time(junk, fallback), fallback)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class FeedApi(unittest.TestCase):
    def setUp(self):
        signed_up(self)
        self.Session = helpers.make_sessionmaker()
        self.client = helpers.api_client(self.Session, helpers.ADMIN)
        self.addCleanup(helpers.reset_overrides)
        self.now = T0 + timedelta(days=60)
        self.redis = FakeRedis()
        self.redis.store[status_feed.KUMA_OK_KEY] = b"1"
        for p in (mock.patch.object(status_feed, "now_utc", lambda: self.now),
                  mock.patch("app.auth.session_manager.get_redis", mock.AsyncMock(return_value=self.redis))):
            p.start()
            self.addCleanup(p.stop)
        db = self.Session()
        helpers.put(db, "integration.uptime_kuma.url", KUMA_URL)
        db.close()

    def send(self, method, path, body=None, origin=ORIGIN):
        return self.client.request(method, path, json=body, headers={"Origin": origin} if origin else {})

    def feed(self, days=None):
        r = self.client.get("/api/status/feed" + (f"?days={days}" if days else ""))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def ago(self, **kw):
        return self.now - timedelta(**kw)

    def test_open_items_are_pinned_and_the_history_is_newest_first(self):
        outage = add_row(self.Session, source="auto", monitor_id=7, message="Media is down", service_name="Media",
                         update_type="incident", started_at=self.ago(hours=2), created_at=self.ago(hours=2))
        urgent = add_row(self.Session, message="Plex restarts at 9", important=True, created_at=self.ago(hours=1))
        plain = add_row(self.Session, message="New shelves on Books", created_at=self.ago(days=3))
        back = add_row(self.Session, source="auto", monitor_id=8, message="Books is back, down 5 min",
                       service_name="Books", active=False, started_at=self.ago(days=2, minutes=5),
                       ended_at=self.ago(days=2), resolved_at=self.ago(days=2), created_at=self.ago(days=2))
        old = add_row(self.Session, message="Long ago", active=False, created_at=self.ago(days=45),
                      resolved_at=self.ago(days=40))
        body = self.feed()
        self.assertEqual([i["id"] for i in body["open"]], [urgent, outage])
        self.assertEqual([i["id"] for i in body["items"]], [back, plain])
        self.assertEqual([i["id"] for i in self.feed(days=41)["items"]], [back, plain, old])
        item = body["open"][1]
        self.assertEqual(item, {"id": outage, "source": "auto", "text": "Media is down", "service": "Media",
                                "important": False, "resolved": False,
                                "started_at": "2026-11-30T10:00:00.000Z", "ended_at": None,
                                "created_at": "2026-11-30T10:00:00.000Z", "at": "2026-11-30T10:00:00.000Z"})
        self.assertEqual(body["items"][0]["at"], "2026-11-28T12:00:00.000Z")
        self.assertTrue(body["items"][0]["resolved"])
        for days in (0, 91, "x"):
            self.assertEqual(self.client.get(f"/api/status/feed?days={days}").status_code, 422)

    def test_state(self):
        # Review Focus 2: no answer from Uptime Kuma lately (or no Redis to
        # ask) is "unavailable", never "ok".
        self.assertEqual(self.feed()["state"], "ok")
        add_row(self.Session, message="Heads up", important=True)
        self.assertEqual(self.feed()["state"], "ok", "a note is not an outage")
        add_row(self.Session, source="auto", monitor_id=7, message="Media is down", started_at=T0)
        self.assertEqual(self.feed()["state"], "down")
        del self.redis.store[status_feed.KUMA_OK_KEY]
        self.assertEqual(self.feed()["state"], "unavailable")
        with mock.patch("app.auth.session_manager.get_redis", mock.AsyncMock(side_effect=ConnectionError("down"))):
            self.redis.store[status_feed.KUMA_OK_KEY] = b"1"
            self.assertEqual(self.feed()["state"], "unavailable")
        db = self.Session()
        helpers.put(db, "integration.uptime_kuma.url", "")
        db.close()
        self.assertEqual(self.feed()["state"], "off")

    def test_members_read_it_and_signed_out_callers_do_not(self):
        add_row(self.Session, source="auto", monitor_id=7, message="Media is down", started_at=T0)
        helpers.reset_overrides()
        member = helpers.api_client(self.Session, helpers.MEMBER)
        self.assertEqual(len(member.get("/api/status/feed").json()["open"]), 1)
        from app.dependencies import get_current_user, get_current_user_optional
        from app.main import app
        del app.dependency_overrides[get_current_user]
        del app.dependency_overrides[get_current_user_optional]
        self.assertEqual(member.get("/api/status/feed").status_code, 401)
        # The old public list of updates is gone: it would name the services.
        self.assertEqual(member.get("/api/status/updates").status_code, 404)

    def test_a_note_is_posted_edited_resolved_and_deleted(self):
        r = self.send("POST", "/api/status/notes", {"text": "  Plex restarts at 9  ", "important": True,
                                                    "service": " Plex "})
        self.assertEqual(r.status_code, 201, r.text)
        note = r.json()
        self.assertEqual((note["text"], note["service"], note["important"], note["source"], note["resolved"]),
                         ("Plex restarts at 9", "Plex", True, "admin", False))
        self.assertEqual([i["id"] for i in self.feed()["open"]], [note["id"]])

        r = self.send("PUT", f"/api/status/notes/{note['id']}", {"text": "Plex restarts at 10", "service": ""})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["text"], r.json()["service"], r.json()["important"]),
                         ("Plex restarts at 10", None, False))
        self.assertEqual([i["id"] for i in self.feed()["items"]], [note["id"]], "not important: not pinned")

        first = self.send("POST", f"/api/status/notes/{note['id']}/resolve").json()
        self.assertTrue(first["resolved"])
        self.now += timedelta(minutes=5)
        again = self.send("POST", f"/api/status/notes/{note['id']}/resolve").json()
        self.assertEqual(again["at"], first["at"], "resolving twice changes nothing")

        self.assertEqual(self.send("DELETE", f"/api/status/notes/{note['id']}").json(), {"success": True})
        self.assertEqual(self.feed()["items"], [])
        self.assertEqual(self.send("DELETE", f"/api/status/notes/{note['id']}").status_code, 404)

    def test_a_note_is_checked(self):
        self.assertEqual(self.send("POST", "/api/status/notes", {"text": "x" * 280}).status_code, 201)
        for body in ({"text": "x" * 281}, {"text": "   "}, {}, {"text": "hi", "important": "yes"},
                     {"text": "hi", "service": "s" * 101}, {"text": "\ud800"}):
            with self.subTest(body=body):
                self.assertEqual(self.send("POST", "/api/status/notes", body).status_code, 422)

    def test_notes_are_admin_only_and_same_origin(self):
        note = add_row(self.Session, message="Heads up", created_at=self.now)
        calls = (("POST", "/api/status/notes", {"text": "hi"}), ("PUT", f"/api/status/notes/{note}", {"text": "hi"}),
                 ("DELETE", f"/api/status/notes/{note}", None), ("POST", f"/api/status/notes/{note}/resolve", None))
        for method, path, body in calls:
            with self.subTest(method=method, path=path):
                self.assertEqual(self.send(method, path, body, origin=None).status_code, 403)
                self.assertEqual(self.send(method, path, body, origin="https://evil.example").status_code, 403)
        helpers.reset_overrides()
        self.client = helpers.api_client(self.Session, helpers.MEMBER)
        for method, path, body in calls:
            with self.subTest(member=path):
                self.assertEqual(self.send(method, path, body).status_code, 403)
        self.assertEqual(self.feed()["items"][0]["text"], "Heads up")

    def test_outages_are_not_notes(self):
        outage = add_row(self.Session, source="auto", monitor_id=7, message="Media is down", started_at=T0)
        for method, path, body in (("PUT", f"/api/status/notes/{outage}", {"text": "hi"}),
                                   ("DELETE", f"/api/status/notes/{outage}", None),
                                   ("POST", f"/api/status/notes/{outage}/resolve", None),
                                   ("PUT", "/api/status/notes/999", {"text": "hi"})):
            self.assertEqual(self.send(method, path, body).status_code, 404)
        for bad in ("0", str(2 ** 63), "x"):
            self.assertEqual(self.send("DELETE", f"/api/status/notes/{bad}").status_code, 422)
        self.assertEqual(self.feed()["open"][0]["text"], "Media is down")

    def test_a_database_that_cannot_be_written_is_a_503(self):
        with mock.patch.object(SASession, "commit", side_effect=OperationalError("x", {}, Exception("locked"))):
            r = self.send("POST", "/api/status/notes", {"text": "hi"})
        self.assertEqual(r.status_code, 503)
        with mock.patch.object(SASession, "query", side_effect=OperationalError("x", {}, Exception("locked"))):
            self.assertEqual(self.client.get("/api/status/feed").status_code, 503)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class HomeEventLogHint(unittest.TestCase):
    """Home renders its event log hidden (pages.py feed_off) only when the feed
    would answer "off" with nothing in it."""

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.now = T0 + timedelta(days=60)

    def off(self):
        db = self.Session()
        try:
            return status_feed.home_off(db, self.now)
        finally:
            db.close()

    def test_off_only_without_uptime_kuma_and_with_nothing_to_show(self):
        self.assertTrue(self.off())
        add_row(self.Session, message="Long ago", active=False, created_at=self.now - timedelta(days=45),
                resolved_at=self.now - timedelta(days=45))
        self.assertTrue(self.off(), "older than the feed's window")
        add_row(self.Session, message="Heads up", created_at=self.now - timedelta(hours=1))
        self.assertFalse(self.off(), "a note shows without Uptime Kuma")

    def test_never_off_with_uptime_kuma(self):
        db = self.Session()
        helpers.put(db, "integration.uptime_kuma.url", KUMA_URL)
        db.close()
        self.assertFalse(self.off())


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class StatusSummary(unittest.TestCase):
    """Review Focus 3: GET /api/integrations/status-summary, public, says the
    one-line current state and nothing more."""

    MONITORS = [
        {"id": 1, "name": "Plex", "status": "up"},
        {"id": 2, "name": "Media", "status": "down"},
        {"id": 9, "name": "Secret Box", "status": "down"},
        {"id": 4, "name": "Requests", "status": "down"},
    ]

    def setUp(self):
        # The route takes no session at all; the client's override is unused.
        signed_up(self)
        self.Session = helpers.make_sessionmaker()
        self.client = helpers.api_client(self.Session)
        self.addCleanup(helpers.reset_overrides)
        db = self.Session()
        helpers.put(db, "monitor.9.enabled", "false")
        db.close()

    def summary(self, monitors):
        with mock.patch("app.integrations.uptime_kuma.read_monitors", mock.AsyncMock(return_value=monitors)):
            r = self.client.get("/api/integrations/status-summary")
        self.assertEqual(r.status_code, 200)
        return r

    def test_something_down_names_one_service_and_nothing_else(self):
        r = self.summary(self.MONITORS)
        self.assertEqual(r.json(), {"status": "issues", "down_service": "Media"})
        for hidden in ("Plex", "Secret Box", "Requests"):
            self.assertNotIn(hidden, r.text)

    def test_a_monitor_switched_off_is_never_named(self):
        r = self.summary([m for m in self.MONITORS if m["id"] in (1, 9)])
        self.assertEqual(r.json(), {"status": "online", "down_service": None})
        self.assertNotIn("Secret Box", r.text)

    def test_all_up(self):
        self.assertEqual(self.summary(self.MONITORS[:1]).json(), {"status": "online", "down_service": None})

    def test_uptime_kuma_not_answering_is_unknown_never_online(self):
        self.assertEqual(self.summary(None).json(), {"status": "unknown", "down_service": None})


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Preferences(unittest.TestCase):
    def test_status_replaces_service(self):
        self.assertIn("status", NOTIFICATION_CATEGORIES)
        self.assertNotIn("service", NOTIFICATION_CATEGORIES)

    def test_status_is_on_by_default_and_can_be_turned_off(self):
        signed_up(self)
        Session = helpers.make_sessionmaker()
        client = helpers.api_client(Session, helpers.MEMBER)
        self.addCleanup(helpers.reset_overrides)
        self.assertTrue(client.get("/api/notifications/preferences").json()["status"])
        r = client.put("/api/notifications/preferences", json={"status": False}, headers={"Origin": ORIGIN})
        self.assertEqual(r.status_code, 200)
        self.assertFalse(client.get("/api/notifications/preferences").json()["status"])
        db = Session()
        try:
            self.assertFalse(poller._user_wants_category(db, helpers.MEMBER["email"], "status"))
        finally:
            db.close()

    def test_the_status_page_belongs_to_home(self):
        from app.pages import PAGE_NAV
        self.assertEqual(PAGE_NAV["status"], "home")


OLD_STATUS_TABLE = (
    "CREATE TABLE status_updates (id INTEGER NOT NULL PRIMARY KEY, title VARCHAR(200) NOT NULL, "
    "message TEXT NOT NULL, update_type VARCHAR(20) NOT NULL, severity VARCHAR(20) NOT NULL, "
    "service_name VARCHAR(100), author_id VARCHAR(100) NOT NULL, author_name VARCHAR(100) NOT NULL, "
    "created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL, active BOOLEAN NOT NULL, resolved_at DATETIME)"
)
NEW_COLUMNS = {"source", "important", "monitor_id", "started_at", "ended_at", "pushed_at"}


def old_database(path):
    """A database from before the status feed: status_updates in its old
    shape with one admin post, and notification choices."""
    from sqlalchemy import create_engine
    from app.database import Base
    engine = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(bind=engine, tables=[t for t in Base.metadata.sorted_tables
                                                  if t.name != "status_updates"])
    with engine.begin() as conn:
        conn.execute(text(OLD_STATUS_TABLE))
        conn.execute(text("INSERT INTO status_updates (title, message, update_type, severity, author_id, "
                          "author_name, active) VALUES ('Old', 'An old post', 'incident', 'warning', '1', 'a', 1)"))
        for who, value in (("off@example.com", "false"), ("on@example.com", "true"), ("chose@example.com", "false")):
            conn.execute(text("INSERT INTO settings (key, value) VALUES (:k, :v)"),
                         {"k": f"notify.{_email_hash(who)}.service", "v": value})
        conn.execute(text("INSERT INTO settings (key, value) VALUES (:k, 'true')"),
                     {"k": f"notify.{_email_hash('chose@example.com')}.status"})
    return engine


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Migration(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = os.path.join(tmp.name, "old.db")
        self.engine = old_database(self.path)
        self.addCleanup(self.engine.dispose)

    def columns(self, db):
        return {row[1] for row in db.execute(text("PRAGMA table_info(status_updates)"))}

    def indexes(self, db):
        return {row[1] for row in db.execute(text("PRAGMA index_list(status_updates)"))}

    def status_pref(self, db, who):
        return db.execute(text("SELECT value FROM settings WHERE key = :k"),
                          {"k": f"notify.{_email_hash(who)}.status"}).scalar()

    def test_adds_the_columns_and_index_once_and_keeps_the_rows(self):
        from app.seed import migrate_status_feed_fields
        db = sessionmaker(bind=self.engine)()
        try:
            with self.assertLogs("app.seed", level=logging.INFO):
                migrate_status_feed_fields(db)
            with self.assertNoLogs("app.seed", level=logging.INFO):
                migrate_status_feed_fields(db)       # idempotent: nothing left to do
            self.assertTrue(NEW_COLUMNS <= self.columns(db))
            self.assertIn("ux_status_updates_open_monitor", self.indexes(db))
            old = db.query(StatusUpdate).one()
            self.assertEqual((old.message, old.source, old.important, old.pushed_at), ("An old post", "admin", False,
                                                                                       None))
            # The feed works on the upgraded table, the index included.
            self.assertIsNotNone(status_feed.open_outage(db, 7, "Media", T0, T0))
            self.assertEqual(len(status_feed.feed(db, 30, T0)["open"]), 1)
            db.add(StatusUpdate(source="auto", monitor_id=7, title="x", message="x", update_type="incident",
                                severity="critical", author_id="", author_name="", active=True))
            with self.assertRaises(IntegrityError):
                db.commit()
            db.rollback()
        finally:
            db.close()

    def test_two_workers_at_once_both_come_up(self):
        # Worker 2 runs the whole migration between worker 1's look at the
        # table and its first ALTER.
        from sqlalchemy import create_engine, event
        from app.seed import migrate_status_feed_fields
        other = create_engine(str(self.engine.url))
        self.addCleanup(other.dispose)
        raced = []

        def other_worker(conn, cursor, statement, parameters, context, executemany):
            if statement.startswith("ALTER TABLE") and not raced:
                raced.append(statement)
                db2 = sessionmaker(bind=other)()
                try:
                    migrate_status_feed_fields(db2)
                finally:
                    db2.close()
        event.listen(self.engine, "before_cursor_execute", other_worker)
        self.addCleanup(event.remove, self.engine, "before_cursor_execute", other_worker)
        db = sessionmaker(bind=self.engine)()
        try:
            migrate_status_feed_fields(db)
            self.assertEqual(len(raced), 1)
            self.assertTrue(NEW_COLUMNS <= self.columns(db))
            self.assertIn("ux_status_updates_open_monitor", self.indexes(db))
        finally:
            db.close()

    def test_no_op_on_a_fresh_schema_and_before_the_tables_exist(self):
        from sqlalchemy import create_engine
        from app.seed import migrate_status_feed_fields, migrate_status_preferences
        db = helpers.make_sessionmaker()()
        try:
            with self.assertNoLogs("app.seed", level=logging.INFO):
                migrate_status_feed_fields(db)
                migrate_status_preferences(db)
            self.assertIn("ux_status_updates_open_monitor", self.indexes(db))
        finally:
            db.close()
        empty = sessionmaker(bind=create_engine("sqlite://"))()
        try:
            migrate_status_feed_fields(empty)        # no tables yet: create_all makes them
            migrate_status_preferences(empty)
            self.assertEqual(self.columns(empty), set())
        finally:
            empty.close()

    def test_service_notifications_turned_off_carry_over_once(self):
        from app.seed import STATUS_PREFERENCES_MARKER, migrate_status_preferences
        db = sessionmaker(bind=self.engine)()
        try:
            with self.assertLogs("app.seed", level=logging.INFO):
                migrate_status_preferences(db)
            self.assertEqual(self.status_pref(db, "off@example.com"), "false")
            self.assertIsNone(self.status_pref(db, "on@example.com"), "on is the default: nothing to carry")
            self.assertEqual(self.status_pref(db, "chose@example.com"), "true", "a choice already made is kept")
            self.assertIsNotNone(db.get(Setting, STATUS_PREFERENCES_MARKER))
            # Turned back on later, it stays on: the carry happens once.
            db.execute(text("UPDATE settings SET value = 'true' WHERE key = :k"),
                       {"k": f"notify.{_email_hash('off@example.com')}.status"})
            db.commit()
            with self.assertNoLogs("app.seed", level=logging.INFO):
                migrate_status_preferences(db)
            self.assertEqual(self.status_pref(db, "off@example.com"), "true")
        finally:
            db.close()

    def test_two_real_workers_start_on_an_old_database(self):
        url = f"sqlite:///{self.path}"
        self.assertEqual(run_together([STARTUP_CHILD, STARTUP_CHILD], url), ["started", "started"])
        self.assertEqual(run_together([STARTUP_CHILD], url), ["started"])      # and a start on the upgraded one
        db = sessionmaker(bind=self.engine)()
        try:
            self.assertTrue(NEW_COLUMNS <= self.columns(db))
            self.assertIn("ux_status_updates_open_monitor", self.indexes(db))
            self.assertEqual([(r.message, r.source) for r in db.query(StatusUpdate).all()],
                             [("An old post", "admin")])
            self.assertEqual(self.status_pref(db, "off@example.com"), "false")
            self.assertEqual(self.status_pref(db, "chose@example.com"), "true")
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
