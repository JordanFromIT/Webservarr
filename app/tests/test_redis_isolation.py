"""
Tests never touch the running instance's Redis.

The suite runs inside the dev container, beside the live instance and its
embedded Redis. app/tests/__init__.py points every Redis client the app makes
(sessions, caches, the last push, the rate limiter, the poller lease) at a
database of its own before the app is imported, so no test can read, write or
count against the instance's live keys, and tests that need real Redis
semantics still get them.
"""
import unittest

try:
    from app.config import settings
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class RedisIsolation(unittest.TestCase):
    def test_every_client_uses_the_test_database(self):
        from app.auth import session_manager
        from app.tests import TEST_REDIS_DB
        self.assertNotEqual(TEST_REDIS_DB, 0)
        want = f"/{TEST_REDIS_DB}"
        self.assertTrue(settings.redis_url.endswith(want), settings.redis_url)
        self.assertTrue(session_manager.redis_url.endswith(want), session_manager.redis_url)

    def test_the_rate_limiter_counts_in_the_test_database(self):
        from app.limiter import limiter
        from app.tests import TEST_REDIS_DB
        self.assertTrue(str(limiter._storage_uri).endswith(f"/{TEST_REDIS_DB}"), limiter._storage_uri)

    def test_the_url_rewrite(self):
        from app.tests import test_redis_url
        self.assertEqual(test_redis_url("redis://localhost:6379/0"), "redis://localhost:6379/15")
        self.assertEqual(test_redis_url("redis://localhost:6379"), "redis://localhost:6379/15")
        self.assertEqual(test_redis_url("redis://:pw@redis:6379/3?socket_timeout=2"),
                         "redis://:pw@redis:6379/15?socket_timeout=2")


if __name__ == "__main__":
    unittest.main()
