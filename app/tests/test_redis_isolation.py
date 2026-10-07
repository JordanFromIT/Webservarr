"""
Tests never touch the running instance's Redis, or another run's.

The suite runs inside the dev container, beside the live instance and its
embedded Redis, and sometimes beside another run of the suite.
app/tests/__init__.py points every Redis client the app makes (sessions,
caches, the last push, the rate limiter, the poller lease, the catalog lock)
at a redis-server of the run's own before the app is imported, so no test can
read, hold, clear or count against a key anyone else is using, and tests that
need real Redis semantics still get them. Without a redis-server to start, the
clients use a database of their own on the configured server instead.
"""
import os
import shutil
import subprocess
import sys
import unittest
from urllib.parse import urlsplit

try:
    from app.config import settings
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
INSTANCE_PORT = 6379  # the embedded Redis the instance runs (supervisord.conf)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class RedisIsolation(unittest.TestCase):
    def test_every_client_uses_the_runs_own_redis(self):
        from app.auth import session_manager
        from app.limiter import limiter
        from app.tests import OWN_REDIS_ENV, TEST_REDIS_DB
        urls = (settings.redis_url, session_manager.redis_url, str(limiter._storage_uri))
        if shutil.which("redis-server"):
            own = os.environ.get(OWN_REDIS_ENV)
            self.assertTrue(own)
            self.assertNotEqual(urlsplit(own).port, INSTANCE_PORT, own)
            for url in urls:
                self.assertEqual(url, own)
        else:
            for url in urls:
                self.assertTrue(url.endswith(f"/{TEST_REDIS_DB}"), url)

    @unittest.skipUnless(shutil.which("redis-server"), "no redis-server to start")
    def test_the_runs_own_redis_answers(self):
        import redis
        r = redis.Redis.from_url(settings.redis_url)
        try:
            self.assertTrue(r.ping())
            self.assertNotEqual(int(r.config_get("port")["port"]), INSTANCE_PORT)
        finally:
            r.close()

    @unittest.skipUnless(shutil.which("redis-server"), "no redis-server to start")
    def test_a_process_a_test_starts_shares_it(self):
        # The catalog's two-worker tests need both children on the parent's server.
        out = subprocess.run([sys.executable, "-c", "import os, app.tests; print(os.environ['REDIS_URL'])"],
                             cwd=ROOT, check=True, capture_output=True, text=True, timeout=60)
        self.assertEqual(out.stdout.strip(), settings.redis_url)

    def test_the_guard_other_tests_use(self):
        from app.tests import is_test_redis
        self.assertTrue(is_test_redis(settings.redis_url))
        self.assertFalse(is_test_redis("redis://localhost:6379/0"))

    def test_the_url_rewrite(self):
        from app.tests import isolated_redis_url
        self.assertEqual(isolated_redis_url("redis://localhost:6379/0"), "redis://localhost:6379/15")
        self.assertEqual(isolated_redis_url("redis://localhost:6379"), "redis://localhost:6379/15")
        self.assertEqual(isolated_redis_url("redis://:pw@redis:6379/3?socket_timeout=2"),
                         "redis://:pw@redis:6379/15?socket_timeout=2")


if __name__ == "__main__":
    unittest.main()
