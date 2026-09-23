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



def _redis_reachable() -> bool:
    if not HAVE_APP:
        return False
    import redis as sync_redis
    from app.config import settings
    try:
        client = sync_redis.Redis.from_url(settings.redis_url, socket_connect_timeout=0.5)
        ok = client.ping()
        client.close()
        return bool(ok)
    except Exception:
        return False


HAVE_REDIS = _redis_reachable()


@unittest.skipUnless(HAVE_REDIS, "needs the container's embedded Redis")
class RealRedisLeaseScripts(unittest.TestCase):
    """The same lease against real Redis, so the Lua scripts actually run.

    FakeRedis above reimplements compare-and-set in Python; these would fail
    if either script were replaced by a plain EXPIRE or DEL. Keys live under
    a throwaway test:lease:<uuid> prefix, never poller:leader.
    """

    def setUp(self):
        import uuid
        self.key = f"test:lease:{uuid.uuid4().hex}"

    def tearDown(self):
        async def _cleanup():
            r = await self._client()
            try:
                await r.delete(self.key)
            finally:
                await r.aclose()
        run(_cleanup())

    async def _client(self):
        import redis.asyncio as aioredis
        from app.config import settings
        return aioredis.from_url(settings.redis_url)

    def _run(self, body):
        async def _wrapped():
            r = await self._client()
            try:
                a = poller.LeaderLease(r, key=self.key, ttl=15, owner="worker-a")
                b = poller.LeaderLease(r, key=self.key, ttl=15, owner="worker-b")
                return await body(r, a, b)
            finally:
                await r.aclose()
        return run(_wrapped())

    def test_holder_renews_and_others_cannot(self):
        async def body(r, a, b):
            self.assertTrue(await a.refresh())
            self.assertFalse(await b.refresh())
            await r.expire(self.key, 3)          # nearly lapsed
            self.assertTrue(await a.refresh())   # the real renew script
            self.assertGreater(await r.ttl(self.key), 10)
            self.assertEqual(await r.get(self.key), b"worker-a")
        self._run(body)

    def test_renew_script_leaves_another_owners_ttl_alone(self):
        async def body(r, a, b):
            self.assertTrue(await b.refresh())
            await r.expire(self.key, 5)
            renewed = await r.eval(poller._RENEW_SCRIPT, 1, self.key, "worker-a", 15)
            self.assertEqual(renewed, 0)
            self.assertLessEqual(await r.ttl(self.key), 5)
            self.assertEqual(await r.get(self.key), b"worker-b")
        self._run(body)

    def test_stale_holder_release_leaves_the_new_holder_untouched(self):
        async def body(r, a, b):
            self.assertTrue(await b.refresh())
            before = await r.pttl(self.key)
            a.held = True                        # a still believes it leads
            await a.release()
            self.assertFalse(a.held)
            self.assertEqual(await r.get(self.key), b"worker-b")
            after = await r.pttl(self.key)
            self.assertGreater(after, 0)
            self.assertLessEqual(after, before)
            self.assertGreater(after, before - 2000)
        self._run(body)

    def test_owner_release_frees_the_lease(self):
        async def body(r, a, b):
            self.assertTrue(await a.refresh())
            await a.release()
            self.assertIsNone(await r.get(self.key))
            self.assertTrue(await b.refresh())
        self._run(body)


if __name__ == "__main__":
    unittest.main()
