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


# What Uptime Kuma's heartbeat endpoint returns for a status page with monitors.
KUMA_PAGE = {"heartbeatList": {"1": [{"status": 1}]}, "uptimeList": {"1_24": 1.0}}


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

    def test_uptime_kuma_page_without_monitors_is_amber(self):
        # Uptime Kuma answers an unknown slug on the heartbeat path with 200
        # and empty lists, not 404.
        slug = {"integration.uptime_kuma.slug": "home"}
        for body in ({"heartbeatList": {}, "uptimeList": {}}, {"uptimeList": {}}, {"heartbeatList": None}):
            with self.subTest(body=body):
                state, reason = health.map_response("uptime_kuma", 200, body, slug)
                self.assertEqual(state, "warn")
                self.assertEqual(reason, 'The status page "home" wasn\'t found or has no monitors')
        # Same slug fallback as the 404 branch.
        self.assertIn('"default"', health.map_response("uptime_kuma", 200, {"heartbeatList": {}}, {})[1])
        self.assertIn('"default"', health.map_response("uptime_kuma", 200, {"heartbeatList": {}},
                                                       {"integration.uptime_kuma.slug": "  "})[1])

    def test_uptime_kuma_answer_that_is_not_an_object_is_amber(self):
        for body in (None, [], "ok", 7):
            with self.subTest(body=body):
                state, reason = health.map_response("uptime_kuma", 200, body, {})
                self.assertEqual(state, "warn")
                self.assertEqual(reason, "It answered, but that address doesn't look like the right service")

    def test_uptime_kuma_page_with_monitors_is_green(self):
        self.assertEqual(health.map_response("uptime_kuma", 200, KUMA_PAGE,
                                             {"integration.uptime_kuma.slug": "home"}), ("ok", "Connected"))

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

    def test_uptime_kuma_probe_reads_the_page(self):
        for body, want in ((KUMA_PAGE, "ok"), ({"heartbeatList": {}, "uptimeList": {}}, "warn")):
            with self.subTest(want=want), \
                 mock.patch.object(health.httpx, "AsyncClient", fake_factory({"heartbeat/home": _Resp(200, body)}, [])):
                self.assertEqual(asyncio.run(health.probe_one("uptime_kuma", self.VALUES))["state"], want)

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
             mock.patch.object(health.httpx, "AsyncClient", fake_factory({"heartbeat": _Resp(200, KUMA_PAGE)}, calls)):
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
            "uptime kuma body": {"heartbeat": _Resp(200, leaky_body)},
            "uptime kuma page": {"heartbeat": _Resp(200, {"heartbeatList": {v: [] for v in SECRETS.values()}})},
        }
        for name, routes in scenarios.items():
            with self.subTest(name):
                results, cached, payload = self._run_everything(routes)
                self._assert_clean(json.dumps(results))
                self._assert_clean(json.dumps(cached))
                self._assert_clean(json.dumps(payload))
                for entry in list(results.values()) + list(cached["integrations"].values()):
                    self.assertEqual(set(entry), {"state", "reason", "checked_at"})



def _private_limiter():
    """Point the shared limiter at a private in-memory store (the real one is
    the Redis the running instance uses). Returns a restore function."""
    from limits.storage import MemoryStorage
    from limits.strategies import FixedWindowRateLimiter
    from app.limiter import limiter
    saved = (limiter._storage, limiter._limiter)
    storage = MemoryStorage()
    limiter._storage, limiter._limiter = storage, FixedWindowRateLimiter(storage)
    limiter.reset()

    def restore():
        limiter.reset()
        limiter._storage, limiter._limiter = saved
    return restore


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TestConnection(unittest.TestCase):
    """POST /api/admin/test-connection runs the status-light probe on the
    values on screen, so Test and the light always agree."""

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        self.client = helpers.api_client(self.Session)

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()
        self.db.close()

    def test_uptime_kuma_test_uses_the_slug(self):
        calls = []
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory({"heartbeat/home": _Resp(404)}, calls)):
            r = self.client.post("/api/admin/test-connection", json={
                "service": "uptime_kuma", "url": "http://192.168.1.7:3001", "slug": "home"})
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["success"])
        self.assertEqual(r.json()["state"], "warn")
        self.assertIn('"home"', r.json()["message"])
        self.assertTrue(calls[0]["url"].endswith("/api/status-page/heartbeat/home"))

    def test_uptime_kuma_without_a_slug_uses_the_saved_one(self):
        # The old Settings page sends no slug: the saved one is what gets tested.
        helpers.put(self.db, "integration.uptime_kuma.slug", "family")
        calls = []
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory({"heartbeat/family": _Resp(200, KUMA_PAGE)}, calls)):
            r = self.client.post("/api/admin/test-connection", json={
                "service": "uptime_kuma", "url": "http://192.168.1.7:3001", "credentials": ""})
        self.assertEqual(r.json(), {"success": True, "message": "Connected", "state": "ok"})
        self.assertTrue(calls[0]["url"].endswith("/api/status-page/heartbeat/family"))

    def test_a_slug_with_no_status_page_is_amber(self):
        calls = []
        routes = {"heartbeat/no-such-page": _Resp(200, {"heartbeatList": {}, "uptimeList": {}})}
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory(routes, calls)):
            r = self.client.post("/api/admin/test-connection", json={
                "service": "uptime_kuma", "url": "http://192.168.1.7:3001", "slug": "no-such-page"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"success": False, "state": "warn",
                                    "message": 'The status page "no-such-page" wasn\'t found or has no monitors'})
        self.assertTrue(calls[0]["url"].endswith("/api/status-page/heartbeat/no-such-page"))

    def test_an_invalid_slug_is_refused_without_a_request(self):
        calls = []
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory({}, calls)):
            r = self.client.post("/api/admin/test-connection", json={
                "service": "uptime_kuma", "url": "http://192.168.1.7:3001", "slug": "../admin"})
        self.assertEqual(r.json()["state"], "warn")
        self.assertFalse(r.json()["success"])
        self.assertEqual(calls, [])

    def test_masked_credential_uses_the_stored_one(self):
        helpers.put(self.db, "integration.sonarr.api_key", "stored-key")
        calls = []
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory({"system/status": _Resp(200, {})}, calls)):
            r = self.client.post("/api/admin/test-connection", json={
                "service": "sonarr", "url": "http://192.168.1.5:8989", "credentials": "***masked***"})
        self.assertTrue(r.json()["success"])
        self.assertEqual(calls[0]["headers"]["X-Api-Key"], "stored-key")

    def test_a_typed_credential_is_tested_as_typed(self):
        helpers.put(self.db, "integration.sonarr.api_key", "stored-key")
        calls = []
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory({"system/status": _Resp(401)}, calls)):
            r = self.client.post("/api/admin/test-connection", json={
                "service": "sonarr", "url": "http://192.168.1.5:8989", "credentials": "new-key"})
        self.assertEqual(calls[0]["headers"]["X-Api-Key"], "new-key")
        self.assertEqual(r.json()["state"], "warn")
        self.assertNotIn("new-key", r.text)

    def test_unsafe_address_is_refused(self):
        calls = []
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory({}, calls)):
            r = self.client.post("/api/admin/test-connection", json={
                "service": "sonarr", "url": "http://127.0.0.1:8989", "credentials": "k"})
        self.assertEqual(r.json()["state"], "error")
        self.assertFalse(r.json()["success"])
        self.assertEqual(calls, [])

    def test_plex_token_travels_in_the_header_not_the_url(self):
        calls = []
        token = SECRETS["integration.plex.token"]
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory({"status/sessions": _Resp(200, {})}, calls)):
            r = self.client.post("/api/admin/test-connection", json={
                "service": "plex", "url": "http://192.168.1.2:32400", "credentials": token})
        self.assertTrue(r.json()["success"], r.text)
        self.assertEqual(len(calls), 1)
        self.assertNotIn(token, calls[0]["url"])
        self.assertNotIn(token, json.dumps(calls[0]["params"]))
        self.assertEqual(calls[0]["headers"]["X-Plex-Token"], token)
        self.assertNotIn(token, r.text)

    def test_nyt_is_testable(self):
        calls = []
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory({"nytimes": _Resp(200, {})}, calls)):
            r = self.client.post("/api/admin/test-connection", json={
                "service": "nyt", "url": "", "credentials": "n-key"})
        self.assertTrue(r.json()["success"], r.text)
        self.assertEqual(calls[0]["params"], {"api-key": "n-key"})

    def test_admin_only(self):
        helpers.reset_overrides()
        member = helpers.api_client(self.Session, helpers.MEMBER)
        r = member.post("/api/admin/test-connection", json={"service": "sonarr", "url": "http://192.168.1.5:8989"})
        self.assertEqual(r.status_code, 403)

    def test_rate_limited_to_twenty_a_minute(self):
        restore = _private_limiter()
        try:
            helpers.set_rate_limits(True)
            body = {"service": "kavita", "url": "http://192.168.1.8:5000"}
            with mock.patch.object(health.httpx, "AsyncClient", fake_factory({}, [])):
                codes = [self.client.post("/api/admin/test-connection", json=body).status_code for _ in range(21)]
            self.assertEqual(codes[:20], [200] * 20)
            self.assertEqual(codes[20], 429)
        finally:
            restore()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ChaptarrOptions(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        self.client = helpers.api_client(self.Session)

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()
        self.db.close()

    def configure(self, url="http://192.168.1.8:8789"):
        helpers.put(self.db, "integration.chaptarr.url", url)
        helpers.put(self.db, "integration.chaptarr.api_key", "c-key")

    def call(self, routes, calls=None):
        # The Chaptarr fetch uses integration_health's client helper, so the
        # fake goes in where that helper builds its client.
        with mock.patch.object(health.httpx, "AsyncClient", fake_factory(routes, [] if calls is None else calls)):
            return self.client.get("/api/admin/chaptarr/options")

    def test_unconfigured(self):
        self.assertEqual(self.call({}).status_code, 400)

    def test_lists_folders_and_profiles(self):
        self.configure()
        calls = []
        r = self.call({
            "rootfolder": _Resp(200, [{"path": "/books", "freeSpace": 1}, {"nope": 1}, {"path": ""}]),
            "qualityprofile": _Resp(200, [{"id": 1, "name": "eBook"}, {"id": "x"}, {"id": True, "name": "Bool"}]),
            "metadataprofile": _Resp(200, [{"id": 2, "name": "Standard"}]),
        }, calls)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"root_folders": [{"path": "/books"}],
                                    "quality_profiles": [{"id": 1, "name": "eBook"}],
                                    "metadata_profiles": [{"id": 2, "name": "Standard"}]})
        self.assertEqual(sorted(c["url"].rsplit("/", 1)[1] for c in calls),
                         ["metadataprofile", "qualityprofile", "rootfolder"])
        self.assertTrue(all(c["headers"]["X-Api-Key"] == "c-key" for c in calls))

    def test_rejected_key_and_unreachable(self):
        self.configure()
        self.assertEqual(self.call({"rootfolder": _Resp(401)}).status_code, 400)
        for code in (401, 403):
            with self.subTest(code=code):
                r = self.call({"metadataprofile": _Resp(code)})
                self.assertEqual(r.status_code, 400)
                self.assertEqual(r.json(), {"detail": "Chaptarr rejected the API key"})
        r = self.call({"rootfolder": httpx.ConnectError("refused")})
        self.assertEqual(r.status_code, 503)
        self.assertNotIn(r.status_code, (502, 504))

    def test_unsafe_address_is_refused_without_a_request(self):
        self.configure("http://127.0.0.1:8789")
        calls = []
        self.assertEqual(self.call({}, calls).status_code, 400)
        self.assertEqual(calls, [])

    def test_admin_only(self):
        self.configure()
        helpers.reset_overrides()
        member = helpers.api_client(self.Session, helpers.MEMBER)
        self.assertEqual(member.get("/api/admin/chaptarr/options").status_code, 403)

    def test_a_slow_answer_is_503_within_the_deadline(self):
        async def slow():
            await asyncio.sleep(5)
            return _Resp(200, [])
        self.configure()
        with mock.patch.object(health, "PROBE_TIMEOUT", 0.2):
            started = time.monotonic()
            r = self.call({"qualityprofile": slow})
            elapsed = time.monotonic() - started
        self.assertEqual(r.status_code, 503, r.text)
        self.assertLess(elapsed, 2.0)

    def test_a_slow_dns_lookup_is_off_the_loop_and_inside_the_deadline(self):
        # The address check resolves the hostname with a blocking getaddrinfo:
        # it must run in a worker thread, under the same one deadline.
        import socket
        import threading
        real_getaddrinfo = socket.getaddrinfo
        release = threading.Event()
        on_loop = []

        def getaddrinfo(host, *args, **kwargs):
            if host == "slow-dns.example":
                try:
                    asyncio.get_running_loop()
                    on_loop.append(True)
                except RuntimeError:
                    on_loop.append(False)
                release.wait(3)
                raise socket.gaierror("lookup timed out")
            return real_getaddrinfo(host, *args, **kwargs)

        self.configure("http://slow-dns.example:8789")
        timer = threading.Timer(1.0, release.set)
        timer.start()
        try:
            with mock.patch.object(health, "PROBE_TIMEOUT", 0.2), \
                 mock.patch("socket.getaddrinfo", getaddrinfo):
                r = self.call({})
        finally:
            release.set()
            timer.cancel()
        self.assertEqual(on_loop, [False])
        self.assertEqual(r.status_code, 503, r.text)

    def test_the_three_requests_run_side_by_side(self):
        # Each answer fits the deadline; one after another they would not.
        async def slow(body):
            await asyncio.sleep(0.3)
            return _Resp(200, body)
        self.configure()
        routes = {"rootfolder": lambda: slow([{"path": "/books"}]),
                  "qualityprofile": lambda: slow([{"id": 1, "name": "eBook"}]),
                  "metadataprofile": lambda: slow([{"id": 2, "name": "Standard"}])}
        with mock.patch.object(health, "PROBE_TIMEOUT", 0.7):
            r = self.call(routes)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["root_folders"], [{"path": "/books"}])

    def test_an_address_httpx_cannot_parse_is_400(self):
        # Real httpx parsing, no fake client: an IDNA-invalid host passes the
        # address check (it doesn't resolve) but httpx refuses to build it.
        self.configure("http://\u2260.example:8789")
        r = self.client.get("/api/admin/chaptarr/options")
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(r.json(), {"detail": "That address isn't valid. Check it and try again."})

    def test_the_registry_refuses_an_address_httpx_cannot_parse(self):
        from app.settings_registry import validate_value
        for key in ("integration.chaptarr.url", "integration.sonarr.url"):
            with self.subTest(key=key):
                self.assertEqual(validate_value(key, "http://\u2260.example:8789"), "That address isn't valid")
        self.assertIsNone(validate_value("integration.chaptarr.url", "http://192.168.1.8:8789"))
        r = self.client.put("/api/admin/settings/bulk", json={"settings": [
            {"key": "integration.chaptarr.url", "value": "http://\u2260.example:8789"}]})
        self.assertEqual(r.status_code, 422, r.text)
        self.assertEqual(helpers.get(self.db, "integration.chaptarr.url"), None)

    def test_an_unexpected_error_is_503_and_logs_only_its_type(self):
        from app.routers import admin_integrations
        self.configure()
        boom = RuntimeError("http://192.168.1.8:8789 c-key")
        with mock.patch.object(admin_integrations, "_fetch_chaptarr_options", mock.AsyncMock(side_effect=boom)), \
             self.assertLogs("app.routers.admin_integrations", level="WARNING") as logs:
            r = self.client.get("/api/admin/chaptarr/options")
        self.assertEqual(r.status_code, 503, r.text)
        self.assertEqual(r.json(), {"detail": "Couldn't reach Chaptarr. Check the address and try again."})
        text = "\n".join(logs.output)
        self.assertIn("RuntimeError", text)
        self.assertNotIn("c-key", text)
        self.assertNotIn("192.168.1.8", text)

    def test_cancellation_still_propagates(self):
        from app.routers import admin_integrations
        with mock.patch.object(admin_integrations, "_fetch_chaptarr_options",
                               mock.AsyncMock(side_effect=asyncio.CancelledError())):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(admin_integrations.chaptarr_options_response("http://192.168.1.8:8789", "c-key"))

    def test_rate_limited_to_twenty_a_minute(self):
        self.configure()
        restore = _private_limiter()
        try:
            helpers.set_rate_limits(True)
            codes = [self.call({}).status_code for _ in range(21)]
            self.assertEqual(codes[:20], [200] * 20)
            self.assertEqual(codes[20], 429)
        finally:
            restore()

    def test_a_redirect_is_not_followed(self):
        seen = []

        def handler(request):
            seen.append(str(request.url))
            if "169.254" in request.url.host:
                return httpx.Response(200, json=[{"path": "/leak"}])
            return httpx.Response(302, headers={"Location": "http://169.254.169.254/latest/meta-data/"})

        real = httpx.AsyncClient
        factory = lambda **kw: real(transport=httpx.MockTransport(handler), **kw)  # noqa: E731
        self.configure()
        with mock.patch.object(health.httpx, "AsyncClient", factory):
            r = self.client.get("/api/admin/chaptarr/options")
        self.assertFalse([u for u in seen if "169.254" in u], seen)
        self.assertEqual(len(seen), 3)
        self.assertEqual(r.status_code, 503, r.text)
        self.assertNotIn("/leak", r.text)



class SetupWizardTest(unittest.TestCase):
    """The setup wizard's Plex test goes to the setup-only route with the
    setup token from step 1, posts the fields it reads, and shows the probe's
    reason when it fails. (There is no admin session before setup.)"""

    def setUp(self):
        import os
        path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static", "setup.html")
        with open(path, encoding="utf-8") as f:
            html = f.read()
        start = html.index("testBtn.addEventListener('click'")
        self.block = html[start:html.index("testBtn.disabled = false", start)]
        self.html = html

    def test_uses_the_setup_route_with_the_setup_token(self):
        self.assertIn("fetch('/api/setup/test-connection'", self.block)
        self.assertNotIn("/api/admin/test-connection", self.html)
        self.assertRegex(self.block, r"\bsetup_token:\s*storedStep1\.token\b")

    def test_posts_credentials(self):
        self.assertRegex(self.block, r"JSON\.stringify\(\{[^}]*\bcredentials:\s*token\b")
        self.assertNotRegex(self.block, r"\bcredential:")

    def test_failure_shows_the_message_first(self):
        self.assertRegex(self.block, r"textContent\s*=\s*data\.message\s*\|\|\s*data\.detail\s*\|\|\s*'Connection failed'")


if __name__ == "__main__":
    unittest.main()
