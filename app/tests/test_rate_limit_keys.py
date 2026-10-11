"""
Rate-limit keys (security audit 2026-10-10, F1 and I1): a limit is one budget
per route function, whatever its path parameters carry, and an IPv6 client is
one bucket per /64. IPv4 stays per address. slowapi's "exceeded" warning
names the route, so Kometa's token never reaches the log through it.

The limits run for real on a private in-memory store, never the shared Redis.
"""
import logging
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
    from starlette.requests import Request

    from app.limiter import rate_limit_key
    from app.routers.activity_webhooks import HideWebhookTokens
    from app.tests.test_integration_health import _private_limiter

KOMETA_TOKEN = "kometaRateToken0123456789abcdefgh"
KOMETA_LIMIT = 30
# A trusted front proxy (loopback), so CF-Connecting-IP is believed.
PROXY = ("127.0.0.1", 50000)


def kometa_path(token):
    return f"/api/webhooks/kometa/{token}"


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TheKey(unittest.TestCase):
    def key(self, cf_ip, peer=PROXY[0]):
        headers = [(b"cf-connecting-ip", cf_ip.encode())] if cf_ip else []
        return rate_limit_key(Request({"type": "http", "method": "GET", "path": "/", "headers": headers,
                                       "client": (peer, 1234), "query_string": b""}))

    def test_ipv6_is_one_bucket_per_64(self):
        self.assertEqual(self.key("2001:db8:1:2::a"), "2001:db8:1:2::/64")
        self.assertEqual(self.key("2001:db8:1:2:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64")
        self.assertEqual(self.key("2001:db8:1:3::a"), "2001:db8:1:3::/64")

    def test_ipv4_stays_per_address(self):
        self.assertEqual(self.key("203.0.113.5"), "203.0.113.5")
        self.assertNotEqual(self.key("203.0.113.5"), self.key("203.0.113.6"))
        self.assertEqual(self.key("::ffff:203.0.113.5"), "203.0.113.5")

    def test_an_untrusted_peer_is_keyed_by_itself(self):
        self.assertEqual(self.key("2001:db8:1:2::a", peer="93.184.216.34"), "93.184.216.34")
        self.assertEqual(self.key(None, peer="2a00:1450:4001:9:1::5"), "2a00:1450:4001:9::/64")

    def test_a_value_that_is_not_an_address_is_kept_as_it_is(self):
        self.assertEqual(self.key(None, peer="testclient"), "testclient")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class KometaBudget(unittest.TestCase):
    """POST /api/webhooks/kometa/<token> is 30 a minute per client, whichever
    tokens the paths carry. Every token here is wrong, so each answer is a
    401 until the budget runs out."""

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
        self.addCleanup(_private_limiter())
        helpers.set_rate_limits(True)
        from app.main import app
        self.client = TestClient(app, client=PROXY)

    def post(self, token, ip="203.0.113.5"):
        return self.client.post(kometa_path(token), json={}, headers={"CF-Connecting-IP": ip}).status_code

    def test_distinct_paths_share_one_budget(self):
        codes = [self.post(f"guess{i:02d}") for i in range(64)]
        self.assertEqual(codes[:KOMETA_LIMIT], [401] * KOMETA_LIMIT)
        self.assertEqual(codes[KOMETA_LIMIT:], [429] * (64 - KOMETA_LIMIT))

    def test_two_addresses_in_one_64_share_a_budget(self):
        codes = [self.post(f"guess{i:02d}", ip=f"2001:db8:1:2::{i % 2 + 1:x}") for i in range(KOMETA_LIMIT)]
        self.assertEqual(codes, [401] * KOMETA_LIMIT)
        self.assertEqual(self.post("next", ip="2001:db8:1:2::abcd"), 429)
        # The neighbouring /64 has a budget of its own.
        self.assertEqual(self.post("next", ip="2001:db8:1:3::1"), 401)

    def test_the_exceeded_warning_names_the_route_not_the_path(self):
        secret = "SECRET-IN-THE-PATH-5e1d"
        for i in range(KOMETA_LIMIT):
            self.post(f"guess{i:02d}")
        with self.assertLogs("slowapi", logging.WARNING) as logged:
            self.assertEqual(self.post(secret), 429)
        text = "\n".join(logged.output)
        self.assertIn("kometa_webhook", text)
        self.assertNotIn(secret, text)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SlowapiLogFilter(unittest.TestCase):
    """Defence in depth: should the warning ever carry the path again, the
    token filter on the slowapi logger hides it."""

    def test_the_filter_is_on_the_slowapi_logger(self):
        import app.main  # noqa: F401 - attaches the filters
        self.assertTrue(any(isinstance(f, HideWebhookTokens) for f in logging.getLogger("slowapi").filters))

    def test_a_path_shaped_scope_is_redacted(self):
        record = logging.LogRecord("slowapi", logging.WARNING, __file__, 1,
                                   "ratelimit %s (%s) exceeded at endpoint: %s",
                                   ("30 per 1 minute", "203.0.113.5", kometa_path(KOMETA_TOKEN)), None)
        self.assertTrue(HideWebhookTokens().filter(record))
        self.assertNotIn(KOMETA_TOKEN, record.getMessage())
        self.assertIn("/api/webhooks/kometa/…", record.getMessage())


if __name__ == "__main__":
    unittest.main()
