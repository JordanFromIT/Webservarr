"""
The poller's Redis leader lease.

uvicorn runs several workers and each one's lifespan starts a poller, so every
change used to be detected once per worker and users got duplicate
notifications. A lease (SET NX EX, renewed each tick) lets exactly one worker
poll; if it dies the lease lapses and another takes over.
"""
import asyncio
import unittest
from unittest import mock

try:
    from app.services import notification_poller as poller
    from app.tests.test_notification_poller import FakeRedis
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False


def run(coro):
    return asyncio.run(coro)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class LeaderLeaseTests(unittest.TestCase):
    def setUp(self):
        self.r = FakeRedis()
        self.a = poller.LeaderLease(self.r, ttl=15, owner="worker-a")
        self.b = poller.LeaderLease(self.r, ttl=15, owner="worker-b")

    def test_only_one_worker_holds_the_lease(self):
        self.assertTrue(run(self.a.refresh()))
        self.assertFalse(run(self.b.refresh()))

    def test_holder_keeps_it_by_renewing(self):
        run(self.a.refresh())
        for _ in range(10):  # well past one TTL, renewed every tick
            self.r.now += 5
            self.assertTrue(run(self.a.refresh()))
            self.assertFalse(run(self.b.refresh()))

    def test_another_worker_takes_over_when_the_leader_dies(self):
        run(self.a.refresh())
        self.r.now += 10
        self.assertFalse(run(self.b.refresh()))  # not lapsed yet
        self.r.now += 6                          # 16s since A's last renewal
        self.assertTrue(run(self.b.refresh()))
        # A comes back: it must not renew or steal B's lease.
        self.assertFalse(run(self.a.refresh()))
        self.assertTrue(run(self.b.refresh()))

    def test_release_hands_over_at_once_and_only_by_the_owner(self):
        run(self.a.refresh())
        run(self.b.refresh())
        run(self.b.release())                    # not the holder: no effect
        self.assertFalse(run(self.b.refresh()))
        run(self.a.release())
        self.assertTrue(run(self.b.refresh()))

    def test_redis_error_means_not_leader(self):
        run(self.a.refresh())
        with mock.patch.object(self.r, "set", side_effect=ConnectionError("down")):
            with self.assertLogs(poller.logger, level="WARNING"):
                self.assertFalse(run(self.a.refresh()))


if __name__ == "__main__":
    unittest.main()
