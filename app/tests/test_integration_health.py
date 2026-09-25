"""
Integration status lights: probes use each integration's real path and
credentials, run in parallel with a per-probe timeout, and map upstream
answers to unconfigured / ok / warn / error with a plain reason.
"""
import asyncio
import json
import time
import unittest
from unittest import mock

try:
    import httpx
    from app.services import integration_health as health
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False


class _Resp:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


class _FakeClient:
    """Answers by URL substring; records every call."""

    def __init__(self, routes, calls):
        self.routes, self.calls = routes, calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def aclose(self):
        return None

    async def get(self, url, headers=None, params=None):
        self.calls.append({"url": url, "headers": headers or {}, "params": params or {}})
        for fragment, action in self.routes.items():
            if fragment in url:
                if isinstance(action, Exception):
                    raise action
                if callable(action):
                    return await action()
                return action
        return _Resp(200, [])


def fake_factory(routes, calls):
    return lambda **kw: _FakeClient(routes, calls)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Mapping(unittest.TestCase):
    def test_spec_table(self):
        # Spec section 10: 200, 401/403, 404 slug, timeout, refused -> ok/warn/warn/error/error.
        self.assertEqual(health.map_response("sonarr", 200)[0], "ok")
        self.assertEqual(health.map_response("sonarr", 401)[0], "warn")
        self.assertEqual(health.map_response("sonarr", 403)[0], "warn")
        state, reason = health.map_response("uptime_kuma", 404, None, {"integration.uptime_kuma.slug": "home"})
        self.assertEqual(state, "warn")
        self.assertIn('"home"', reason)
        self.assertEqual(health.map_exception(httpx.ConnectTimeout("slow"))[0], "error")
        self.assertEqual(health.map_exception(httpx.ConnectError("refused"))[0], "error")
        self.assertEqual(health.map_exception(asyncio.TimeoutError())[0], "error")

    def test_nothing_to_check_and_missing_keys(self):
        self.assertEqual(health.build_probe("sonarr", {})[1][0], "unconfigured")
        self.assertEqual(health.build_probe("nyt", {})[1][0], "unconfigured")
        self.assertEqual(health.build_probe("sonarr", {"integration.sonarr.url": "http://192.168.1.5:8989"})[1][0], "warn")
        self.assertEqual(health.build_probe("sonarr", {"integration.sonarr.url": "http://127.0.0.1:8989",
                                                       "integration.sonarr.api_key": "k"})[1][0], "error")
        probe, immediate = health.build_probe("kavita", {"integration.kavita.url": "http://192.168.1.50:5000/"})
        self.assertIsNone(immediate)
        self.assertEqual(probe["url"], "http://192.168.1.50:5000/api/health")

    def test_chaptarr_missing_root_folder_is_amber(self):
        state, reason = health.map_response("chaptarr", 200, [{"path": "/books"}],
                                            {"integration.chaptarr.root_folder": "/ebooks"})
        self.assertEqual(state, "warn")
        self.assertIn("/ebooks", reason)
        self.assertEqual(health.map_response("chaptarr", 200, [{"path": "/ebooks/"}],
                                             {"integration.chaptarr.root_folder": "/ebooks"})[0], "ok")

    def test_chaptarr_missing_audiobook_folder_is_amber(self):
        state, reason = health.map_response("chaptarr", 200, [{"path": "/ebooks"}],
                                            {"integration.chaptarr.audiobook_root_folder": "/audiobooks"})
        self.assertEqual(state, "warn")
        self.assertIn("/audiobooks", reason)
        self.assertIn("audiobook", reason)
        self.assertEqual(health.map_response("chaptarr", 200, [{"path": "/ebooks"}, {"path": "/audiobooks/"}],
                                             {"integration.chaptarr.root_folder": "/ebooks",
                                              "integration.chaptarr.audiobook_root_folder": "/audiobooks"})[0], "ok")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Probing(unittest.TestCase):
    VALUES = {
        "integration.sonarr.url": "http://192.168.1.5:8989", "integration.sonarr.api_key": "s-key",
        "integration.radarr.url": "http://192.168.1.6:7878", "integration.radarr.api_key": "r-key",
        "integration.uptime_kuma.url": "http://192.168.1.7:3001", "integration.uptime_kuma.slug": "home",
    }

    def test_probe_uses_the_real_path_and_key(self):
        calls = []
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory({"system/status": _Resp(200, {})}, calls)):
            result = asyncio.run(health.probe_one("sonarr", self.VALUES))
        self.assertEqual(result["state"], "ok")
        self.assertTrue(calls[0]["url"].endswith("/api/v3/system/status"))
        self.assertEqual(calls[0]["headers"]["X-Api-Key"], "s-key")

    def test_uptime_kuma_probe_uses_the_slug(self):
        calls = []
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory({"heartbeat/home": _Resp(404)}, calls)):
            result = asyncio.run(health.probe_one("uptime_kuma", self.VALUES))
        self.assertEqual(result["state"], "warn")
        self.assertTrue(calls[0]["url"].endswith("/api/status-page/heartbeat/home"))

    def test_one_slow_integration_does_not_hold_up_the_rest(self):
        async def slow():
            await asyncio.sleep(5)
            return _Resp(200, {})
        calls = []
        routes = {"192.168.1.5": slow, "192.168.1.6": _Resp(200, {})}
        with mock.patch.object(health, "PROBE_TIMEOUT", 0.2), \
             mock.patch.object(health.httpx, "AsyncClient", fake_factory(routes, calls)):
            started = time.monotonic()
            results = asyncio.run(health.check_all(self.VALUES))
            elapsed = time.monotonic() - started
        self.assertLess(elapsed, 2.0)
        self.assertEqual(results["sonarr"]["state"], "error")
        self.assertEqual(results["radarr"]["state"], "ok")
        self.assertEqual(results["plex"]["state"], "unconfigured")
        self.assertEqual(set(results), set(health.IDS))

    def test_get_health_serves_cache_and_refreshes_one(self):
        cached = {"checked_at": "2026-01-01T00:00:00Z",
                  "integrations": {i: {"state": "ok", "reason": "Connected", "checked_at": "x"} for i in health.IDS}}
        write = mock.AsyncMock()
        check = mock.AsyncMock(return_value={"sonarr": {"state": "error", "reason": "No answer", "checked_at": "y"}})
        with mock.patch.object(health, "_cache_read", mock.AsyncMock(return_value=cached)), \
             mock.patch.object(health, "_cache_write", write), \
             mock.patch.object(health, "check_all", check):
            self.assertEqual(asyncio.run(health.get_health({})), cached)
            check.assert_not_called()
            fresh = asyncio.run(health.get_health({}, refresh=True, only="sonarr"))
        check.assert_called_once_with({}, "sonarr")
        self.assertEqual(fresh["integrations"]["sonarr"]["state"], "error")
        self.assertEqual(fresh["integrations"]["radarr"]["state"], "ok")
        write.assert_called_once()

    def test_probes_run_in_parallel(self):
        # Three probes that never answer: side by side they finish in about one
        # PROBE_TIMEOUT; one after another they would take three.
        async def slow():
            await asyncio.sleep(5)
            return _Resp(200, {})
        calls = []
        routes = {"192.168.1.5": slow, "192.168.1.6": slow, "192.168.1.7": slow}
        with mock.patch.object(health, "PROBE_TIMEOUT", 0.5), \
             mock.patch.object(health.httpx, "AsyncClient", fake_factory(routes, calls)):
            started = time.monotonic()
            results = asyncio.run(health.check_all(self.VALUES))
            elapsed = time.monotonic() - started
        self.assertLess(elapsed, 2 * 0.5)
        for service in ("sonarr", "radarr", "uptime_kuma"):
            self.assertEqual(results[service]["state"], "error", service)

    def test_slow_dns_is_bounded_and_does_not_block_the_loop(self):
        # A hostname whose lookup hangs: the address check must run off the
        # event loop and share the probe's one PROBE_TIMEOUT deadline.
        import socket
        import threading
        real_getaddrinfo = socket.getaddrinfo
        release = threading.Event()

        def getaddrinfo(host, *args, **kwargs):
            if host == "slow-dns.example":
                release.wait(3)
                raise socket.gaierror("lookup timed out")
            return real_getaddrinfo(host, *args, **kwargs)

        values = dict(self.VALUES, **{"integration.sonarr.url": "http://slow-dns.example:8989"})
        calls = []

        async def run():
            ticks, running = [], [True]

            async def heartbeat():
                last = time.monotonic()
                while running[0]:
                    await asyncio.sleep(0.02)
                    now = time.monotonic()
                    ticks.append(now - last)
                    last = now

            beat = asyncio.create_task(heartbeat())
            await asyncio.sleep(0.05)
            started = time.monotonic()
            try:
                results = await health.check_all(values)
            finally:
                elapsed = time.monotonic() - started
                release.set()      # free the worker thread so asyncio.run can shut down
            await asyncio.sleep(0.05)
            running[0] = False
            await beat
            return results, elapsed, max(ticks)

        with mock.patch.object(health, "PROBE_TIMEOUT", 0.3), \
             mock.patch("socket.getaddrinfo", getaddrinfo), \
             mock.patch.object(health.httpx, "AsyncClient", fake_factory({}, calls)):
            results, elapsed, worst_gap = asyncio.run(run())
        self.assertLess(elapsed, 0.3 + 0.5)
        self.assertEqual(results["sonarr"]["state"], "error")
        self.assertEqual(results["radarr"]["state"], "ok")
        self.assertEqual(results["uptime_kuma"]["state"], "ok")
        self.assertLess(worst_gap, 0.2)

    def test_a_cache_that_is_not_a_map_is_cold(self):
        fresh = {i: {"state": "ok", "reason": "Connected", "checked_at": "y"} for i in health.IDS}
        for bad in ([1, 2], "stale", 7, {"integrations": ["sonarr"]}, {"integrations": "x"},
                    {"integrations": {i: "ok" for i in health.IDS}}):
            with self.subTest(bad=bad):
                check = mock.AsyncMock(return_value=fresh)
                with mock.patch.object(health, "_cache_read", mock.AsyncMock(return_value=bad)), \
                     mock.patch.object(health, "_cache_write", mock.AsyncMock()), \
                     mock.patch.object(health, "check_all", check):
                    served = asyncio.run(health.get_health({}))
                    refreshed = asyncio.run(health.get_health({}, refresh=True, only="sonarr"))
                self.assertEqual(served["integrations"], fresh)
                self.assertEqual(refreshed["integrations"], fresh)
                # Cold cache: even a single-service refresh checks everything.
                self.assertEqual(check.call_args_list, [mock.call({}), mock.call({})])

    def test_cache_round_trips_through_redis(self):
        class FakeRedis:
            def __init__(self):
                self.store, self.sets = {}, []

            async def get(self, key):
                return self.store.get(key)

            async def set(self, key, value, ex=None):
                self.sets.append((key, ex))
                self.store[key] = value.encode() if isinstance(value, str) else value

        from app.auth import session_manager
        redis = FakeRedis()
        fresh = {i: {"state": "ok", "reason": "Connected", "checked_at": "y"} for i in health.IDS}
        check = mock.AsyncMock(return_value=fresh)
        with mock.patch.object(session_manager, "get_redis", mock.AsyncMock(return_value=redis)), \
             mock.patch.object(health, "check_all", check):
            first = asyncio.run(health.get_health({}))
            second = asyncio.run(health.get_health({}))
        self.assertEqual(redis.sets, [("webservarr:cache:integration-health", 30)])
        self.assertEqual(json.loads(redis.store["webservarr:cache:integration-health"]), first)
        self.assertEqual(second, first)
        check.assert_called_once_with({})


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Endpoint(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()

    def test_shape_unknown_service_and_members(self):
        from app.routers import admin_integrations
        payload = {"checked_at": "t", "integrations": {i: {"state": "unconfigured", "reason": "Not set up yet",
                                                          "checked_at": "t"} for i in health.IDS}}
        admin = helpers.api_client(self.Session)
        with mock.patch.object(admin_integrations, "get_health", mock.AsyncMock(return_value=payload)):
            r = admin.get("/api/admin/integrations/health")
            self.assertEqual(r.status_code, 200)
            self.assertEqual(set(r.json()["integrations"]), set(health.IDS))
            self.assertEqual(admin.get("/api/admin/integrations/health?service=nope").status_code, 400)
        helpers.reset_overrides()
        member = helpers.api_client(self.Session, helpers.MEMBER)
        self.assertEqual(member.get("/api/admin/integrations/health").status_code, 403)

    def test_rate_limited_to_twenty_a_minute(self):
        # The real limiter storage is the Redis the running instance shares, so
        # this test counts in a private in-memory store, reset before and after.
        from limits.storage import MemoryStorage
        from limits.strategies import FixedWindowRateLimiter
        from app.limiter import limiter
        from app.routers import admin_integrations
        saved = (limiter._storage, limiter._limiter)
        storage = MemoryStorage()
        limiter._storage, limiter._limiter = storage, FixedWindowRateLimiter(storage)
        try:
            limiter.reset()
            admin = helpers.api_client(self.Session)
            helpers.set_rate_limits(True)
            payload = {"checked_at": "t", "integrations": {}}
            with mock.patch.object(admin_integrations, "get_health", mock.AsyncMock(return_value=payload)):
                codes = [admin.get("/api/admin/integrations/health").status_code for _ in range(21)]
            self.assertEqual(codes[:20], [200] * 20)
            self.assertEqual(codes[20], 429)
        finally:
            limiter.reset()
            limiter._storage, limiter._limiter = saved


# Distinctive credential strings: if any reaches a result, a reason or the
# cache, the test names it.
SECRETS = {
    "integration.plex.token": "PLEXTOKEN-9f3e1c",
    "integration.seerr.api_key": "SEERRKEY-7a2b4d",
    "integration.chaptarr.api_key": "CHAPTARRKEY-5c8e0f",
    "integration.nyt.api_key": "NYTKEY-3d6a9b",
    "integration.sonarr.api_key": "SONARRKEY-1e4f7a",
    "integration.radarr.api_key": "RADARRKEY-8b2c5e",
    "integration.netdata.api_key": "NETDATAKEY-6f9d2a",
}
ALL_VALUES = dict(SECRETS, **{
    "integration.plex.url": "http://192.168.1.2:32400",
    "integration.seerr.url": "http://192.168.1.3:5055",
    "integration.chaptarr.url": "http://192.168.1.4:8789",
    "integration.chaptarr.root_folder": "/ebooks",
    "integration.kavita.url": "http://192.168.1.8:5000",
    "integration.sonarr.url": "http://192.168.1.5:8989",
    "integration.radarr.url": "http://192.168.1.6:7878",
    "integration.uptime_kuma.url": "http://192.168.1.7:3001",
    "integration.uptime_kuma.slug": "home",
    "integration.netdata.url": "http://192.168.1.9:19999",
})


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Safety(unittest.TestCase):
    """Ruling R71: token in a header, no redirects, no secrets in any result."""

    def test_plex_token_travels_in_the_header_not_the_url(self):
        calls = []
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory({"status/sessions": _Resp(200, {})}, calls)):
            result = asyncio.run(health.probe_one("plex", ALL_VALUES))
        self.assertEqual(result["state"], "ok")
        token = SECRETS["integration.plex.token"]
        self.assertTrue(calls[0]["url"].endswith("/status/sessions"))
        self.assertNotIn(token, calls[0]["url"])
        self.assertNotIn(token, json.dumps(calls[0]["params"]))
        self.assertEqual(calls[0]["headers"]["X-Plex-Token"], token)

    def test_probes_never_follow_redirects(self):
        # A LAN service answering 302 -> the metadata address must not get a
        # second request: that would step around is_safe_integration_url.
        seen = []

        def handler(request):
            seen.append(str(request.url))
            if "169.254" in request.url.host:
                return httpx.Response(200, json={})
            return httpx.Response(302, headers={"Location": "http://169.254.169.254/latest/meta-data/"})

        real = httpx.AsyncClient
        factory = lambda **kw: real(transport=httpx.MockTransport(handler), **kw)  # noqa: E731
        with mock.patch.object(health.httpx, "AsyncClient", factory):
            single = asyncio.run(health.probe_one("sonarr", ALL_VALUES))
            together = asyncio.run(health.check_all(ALL_VALUES, "radarr"))
        self.assertFalse([u for u in seen if "169.254" in u], seen)
        self.assertEqual(len(seen), 2)
        self.assertEqual(single["state"], "warn")
        self.assertEqual(together["radarr"]["state"], "warn")

    def _assert_clean(self, blob):
        for key, secret in SECRETS.items():
            self.assertNotIn(secret, blob, key)

    def _run_everything(self, routes):
        calls = []
        written = mock.AsyncMock()
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory(routes, calls)), \
             mock.patch.object(health, "_cache_read", mock.AsyncMock(return_value=None)), \
             mock.patch.object(health, "_cache_write", written):
            results = asyncio.run(health.check_all(ALL_VALUES))
            payload = asyncio.run(health.get_health(ALL_VALUES, refresh=True))
        self.assertEqual(set(results), set(health.IDS))
        written.assert_called_once()
        return results, written.call_args[0][0], payload

    def test_no_credential_reaches_a_result_or_the_cache(self):
        leaky_body = {"error": " ".join(SECRETS.values()), "echo": list(SECRETS.values())}
        scenarios = {
            "success": {},
            "rejected": {"192.168": _Resp(401, leaky_body)},
            "server error": {"192.168": _Resp(500, leaky_body), "nytimes": _Resp(500, leaky_body)},
            "redirect": {"192.168": _Resp(302, leaky_body), "nytimes": _Resp(302, leaky_body)},
            "refused": {"192.168": httpx.ConnectError("refused " + " ".join(SECRETS.values())),
                        "nytimes": httpx.ConnectError("refused " + " ".join(SECRETS.values()))},
            "crash": {"192.168": RuntimeError(" ".join(SECRETS.values())),
                      "nytimes": RuntimeError(" ".join(SECRETS.values()))},
            "chaptarr body": {"rootfolder": _Resp(200, [{"path": v} for v in SECRETS.values()])},
        }
        for name, routes in scenarios.items():
            with self.subTest(name):
                results, cached, payload = self._run_everything(routes)
                self._assert_clean(json.dumps(results))
                self._assert_clean(json.dumps(cached))
                self._assert_clean(json.dumps(payload))
                for entry in list(results.values()) + list(cached["integrations"].values()):
                    self.assertEqual(set(entry), {"state", "reason", "checked_at"})


if __name__ == "__main__":
    unittest.main()
