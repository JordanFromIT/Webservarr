"""
Notification poller: who gets service alerts, and when.

* Service alerts reach users with a push subscription even when Redis holds no
  session for them (Redis is emptied on every restart, so right after a deploy
  nobody has one).
* The dedup reference identifies one monitor *transition*: the same monitor
  going down again later alerts again, one transition never alerts twice.
"""
import asyncio
import fnmatch
import unittest
from unittest import mock

try:
    from app.models import Notification, PushSubscription
    from app.services import notification_poller as poller
    from app.tests.test_push import make_session_factory
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False


class FakeRedis:
    """The slice of redis.asyncio the poller uses, with a hand-driven clock
    (expiry and the lease scripts are used by test_poller_lease)."""

    def __init__(self):
        self.now = 0.0
        self.store = {}
        self.hashes = {}
        self.expiry = {}

    def _live(self, key):
        exp = self.expiry.get(key)
        if exp is not None and exp <= self.now:
            self.store.pop(key, None)
            self.expiry.pop(key, None)
        return key in self.store

    async def get(self, key):
        return self.store[key] if self._live(key) else None

    async def set(self, key, value, nx=False, ex=None):
        if nx and self._live(key):
            return None
        self.store[key] = value.encode() if isinstance(value, str) else value
        if ex is not None:
            self.expiry[key] = self.now + ex
        else:
            self.expiry.pop(key, None)
        return True

    async def eval(self, script, numkeys, key, owner, *args):
        mine = self._live(key) and self.store[key] == owner.encode()
        if script == poller._RENEW_SCRIPT:
            if not mine:
                return 0
            self.expiry[key] = self.now + int(args[0])
            return 1
        if script == poller._RELEASE_SCRIPT:
            if not mine:
                return 0
            self.store.pop(key, None)
            self.expiry.pop(key, None)
            return 1
        raise AssertionError("unexpected script")

    async def scan(self, cursor, match="*", count=100):
        return 0, [k.encode() for k in self.hashes if fnmatch.fnmatch(k, match)]

    async def hgetall(self, key):
        key = key.decode() if isinstance(key, bytes) else key
        return {k.encode(): v.encode() for k, v in self.hashes.get(key, {}).items()}


def run(coro):
    return asyncio.run(coro)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class MonitorAlertTests(unittest.TestCase):
    def setUp(self):
        self.Session = make_session_factory()
        self.r = FakeRedis()
        self.pushed = []

    def _subscribe(self, email):
        db = self.Session()
        try:
            db.add(PushSubscription(user_email=email, endpoint="https://push.example.com/x",
                                    p256dh="p", auth="a"))
            db.commit()
        finally:
            db.close()

    def _poll(self, status, since, first_run=False):
        monitors = [{"id": 7, "name": "Media", "status": status, "status_since": since,
                     "last_check": since}]

        async def fake_push(emails, title, body, category, url="/"):
            self.pushed.append((sorted(emails), title))
            return len(emails)

        with mock.patch.object(poller, "SessionLocal", self.Session), \
             mock.patch.object(poller, "send_push_to_users", fake_push), \
             mock.patch("app.integrations.uptime_kuma.get_monitors",
                        mock.AsyncMock(return_value=monitors)):
            run(poller._poll_monitors(self.r, first_run))

    def _rows(self, email):
        db = self.Session()
        try:
            return [(n.title, n.reference_id) for n in
                    db.query(Notification).filter(Notification.user_email == email)
                    .order_by(Notification.id).all()]
        finally:
            db.close()

    def test_push_subscriber_without_session_gets_the_alert(self):
        self._subscribe("owner@example.com")  # no session:* key anywhere
        self._poll("up", "2026-01-01 10:00:00", first_run=True)
        self._poll("down", "2026-01-01 11:00:00")

        self.assertEqual([t for t, _ in self._rows("owner@example.com")], ["Media is down"])
        self.assertEqual(self.pushed, [(["owner@example.com"], "Media is down")])

    def test_session_users_and_subscribers_are_merged(self):
        self._subscribe("owner@example.com")
        self.r.hashes["session:abc"] = {"email": "Friend@Example.com"}
        self._poll("up", "t0", first_run=True)
        self._poll("down", "t1")

        self.assertEqual(self.pushed[0][0], ["friend@example.com", "owner@example.com"])

    def test_a_later_outage_alerts_again(self):
        self._subscribe("owner@example.com")
        self._poll("up", "2026-01-01 10:00:00", first_run=True)
        self._poll("down", "2026-01-01 11:00:00")
        self._poll("up", "2026-01-01 11:05:00")
        self._poll("down", "2026-01-02 09:00:00")

        titles = [t for t, _ in self._rows("owner@example.com")]
        self.assertEqual(titles, ["Media is down", "Media is up", "Media is down"])

    def test_one_transition_never_alerts_twice(self):
        self._subscribe("owner@example.com")
        self._poll("up", "2026-01-01 10:00:00", first_run=True)
        self._poll("down", "2026-01-01 11:00:00")
        # The same transition seen again (e.g. a second poller that read the
        # old snapshot): the dedup reference matches, nothing new is sent.
        self.r.store["poller:monitor:7"] = b"up"
        self._poll("down", "2026-01-01 11:00:00")

        self.assertEqual(len(self._rows("owner@example.com")), 1)
        self.assertEqual(len(self.pushed), 1)

    def test_first_run_seeds_silently(self):
        self._subscribe("owner@example.com")
        self._poll("down", "t0", first_run=True)
        self.assertEqual(self._rows("owner@example.com"), [])
        self.assertEqual(self.pushed, [])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class StatusSinceTests(unittest.TestCase):
    """get_monitors reports when the current status began."""

    def _monitors(self, beats):
        from app.integrations import uptime_kuma

        class Resp:
            def __init__(self, data):
                self.status_code = 200
                self._data = data

            def json(self):
                return self._data

        class Client:
            def __init__(self, **kw):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def get(self, url, **kw):
                if "/heartbeat/" in url:
                    return Resp({"heartbeatList": {"7": beats}, "uptimeList": {}})
                return Resp({"publicGroupList": []})

        with mock.patch.object(uptime_kuma, "_get_config",
                               return_value={"url": "http://kuma.invalid", "slug": "s"}), \
             mock.patch.object(uptime_kuma.httpx, "AsyncClient", Client):
            return run(uptime_kuma.get_monitors())

    def test_status_since_is_the_first_beat_of_the_current_run(self):
        beats = [
            {"status": 1, "time": "t1"},
            {"status": 0, "time": "t2"},
            {"status": 0, "time": "t3"},
            {"status": 0, "time": "t4"},
        ]
        mon = self._monitors(beats)[0]
        self.assertEqual(mon["status"], "down")
        self.assertEqual(mon["status_since"], "t2")
        self.assertEqual(mon["last_check"], "t4")


if __name__ == "__main__":
    unittest.main()
