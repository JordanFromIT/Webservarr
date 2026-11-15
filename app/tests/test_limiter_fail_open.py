"""
The rate limiter fails open when Redis refuses writes.

Redis persists to data/redis, so a full data disk makes it answer MISCONF to
every write. The limiter writes on every request; it used to raise, and every
page returned 500. Now it counts in memory instead (per worker), so pages
keep working and limits still apply.

Run on a store that raises like Redis does, never the shared Redis.
"""
import unittest
from unittest import mock

from app.tests import helpers

try:
    import fastapi  # noqa: F401 - only present with the app's dependencies
    HAVE_APP = True
except ImportError:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

if HAVE_APP:
    from fastapi.testclient import TestClient
    from limits.storage import MemoryStorage
    from limits.strategies import FixedWindowRateLimiter
    from redis.exceptions import ResponseError

    from app.limiter import limiter

    class _DiskFullStorage(MemoryStorage):
        """Answers pings but refuses writes, as Redis does on a full disk."""

        def incr(self, *args, **kwargs):
            raise ResponseError("MISCONF Errors writing to the AOF file: No space left on device")

        def check(self):
            return True

KOMETA_TOKEN = "kometaFailOpenToken0123456789abcd"
KOMETA_LIMIT = 30
PROXY = ("127.0.0.1", 50000)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class LimiterFailsOpen(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        db = self.Session()
        helpers.put(db, "integration.kometa.webhook_token", KOMETA_TOKEN)
        db.close()
        for p in (mock.patch("app.integrations.config.SessionLocal", self.Session),
                  mock.patch("app.routers.setup.is_setup_completed", return_value=True)):
            p.start()
            self.addCleanup(p.stop)
        helpers.api_client(self.Session)
        self.addCleanup(helpers.reset_overrides)

        saved = (limiter._storage, limiter._limiter, limiter._storage_dead)
        storage = _DiskFullStorage()
        limiter._storage, limiter._limiter = storage, FixedWindowRateLimiter(storage)
        limiter._fallback_limiter.storage.reset()

        def restore():
            limiter._fallback_limiter.storage.reset()
            limiter._storage, limiter._limiter, limiter._storage_dead = saved
        self.addCleanup(restore)
        helpers.set_rate_limits(True)
        from app.main import app
        self.client = TestClient(app, client=PROXY)

    def post(self, token):
        return self.client.post(f"/api/webhooks/kometa/{token}", json={},
                                headers={"CF-Connecting-IP": "203.0.113.9"}).status_code

    def test_requests_still_answer_and_are_still_limited(self):
        codes = [self.post(f"guess{i:02d}") for i in range(KOMETA_LIMIT + 2)]
        self.assertNotIn(500, codes)
        self.assertEqual(codes[:KOMETA_LIMIT], [401] * KOMETA_LIMIT)
        self.assertEqual(codes[KOMETA_LIMIT:], [429, 429])

    def test_configured_to_fail_open(self):
        self.assertTrue(limiter._swallow_errors)
        self.assertTrue(limiter._in_memory_fallback_enabled)


if __name__ == "__main__":
    unittest.main()
