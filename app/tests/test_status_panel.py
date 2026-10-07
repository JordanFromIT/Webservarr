"""
The header's status panel: what GET /api/integrations/service-status sends
(the last 50 checks and the uptime windows), how the uptime badges are read
and cached, Uptime Kuma not answering, and the public summary staying
aggregate-only.

Uptime Kuma is faked at the HTTP client (httpx.AsyncClient) and Redis by
test_notification_poller's FakeRedis. The badge samples are real answers from
Uptime Kuma 1.23.17 (kuma_badge_samples.json).
"""
import asyncio
import json
import os
import unittest
from datetime import datetime, timedelta
from unittest import mock

from app.tests import helpers

try:
    import httpx  # noqa: F401 - only present with the app's dependencies
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

if HAVE_APP:
    from app.integrations import uptime_kuma
    from app.tests.test_notification_poller import FakeRedis

HERE = os.path.dirname(__file__)
with open(os.path.join(HERE, "kuma_badge_samples.json"), encoding="utf-8") as f:
    SAMPLES = json.load(f)["samples"]

T0 = datetime(2026, 10, 6, 1, 0, 0)
CONFIG = {"url": "http://kuma.invalid", "slug": "home"}


def run(coro):
    return asyncio.run(coro)


def kuma_time(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def beats(n=60, status=1, ping=50, every=20):
    return [{"status": status, "ping": ping, "msg": "", "time": kuma_time(T0 + timedelta(seconds=i * every))}
            for i in range(n)]


class Resp:
    def __init__(self, status_code=200, data=None, text=""):
        self.status_code = status_code
        self._data = data
        self.text = text

    def json(self):
        return self._data


class FakeKuma:
    """Uptime Kuma's public endpoints. badges: {(id, hours): svg text or an
    exception to raise}. down: every request fails to connect."""

    def __init__(self, heartbeat=None, names=None, badges=None, down=False, delay=0):
        self.heartbeat = heartbeat or {}
        self.names = names or {}
        self.badges = badges or {}
        self.down = down
        self.delay = delay
        self.calls = []
        self.headers = {}

    def client(self, **kw):
        kuma = self

        class Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def get(self, url, headers=None, **kw):
                kuma.calls.append(url)
                kuma.headers[url] = dict(headers or {})
                if kuma.delay:
                    await asyncio.sleep(kuma.delay)
                if kuma.down:
                    raise httpx.ConnectError("refused")
                if "/api/badge/" in url:
                    parts = url.rsplit("/", 3)
                    key = (int(parts[-3]), int(parts[-1]))
                    got = kuma.badges.get(key, SAMPLES["n/a"]["svg"])
                    if isinstance(got, Exception):
                        raise got
                    return Resp(text=got)
                if "/heartbeat/" in url:
                    return Resp(data={"heartbeatList": {str(k): v for k, v in kuma.heartbeat.items()},
                                      "uptimeList": {f"{k}_24": 0.9938517392167996 for k in kuma.heartbeat}})
                return Resp(data={"publicGroupList": [{"monitorList": [
                    {"id": k, "name": v} for k, v in kuma.names.items()]}]})

        return Client()

    def patch(self, case, redis=None):
        for p in (mock.patch.object(uptime_kuma, "_get_config", return_value=CONFIG),
                  mock.patch.object(uptime_kuma.httpx, "AsyncClient", self.client),
                  mock.patch.object(uptime_kuma, "_redis", mock.AsyncMock(return_value=redis or FakeRedis()))):
            p.start()
            case.addCleanup(p.stop)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class BadgeParsing(unittest.TestCase):
    def test_real_samples(self):
        for key, sample in SAMPLES.items():
            self.assertEqual(uptime_kuma.parse_badge_percent(sample["svg"]), sample["expect"], key)

    def test_the_title_alone_is_enough(self):
        svg = SAMPLES["3/720"]["svg"]
        no_label = svg.replace('aria-label="Uptime (720h): 99.72%"', 'aria-label="x"')
        self.assertNotEqual(no_label, svg)
        self.assertEqual(uptime_kuma.parse_badge_percent(no_label), 99.72)

    def test_anything_else_is_none(self):
        for bad in (None, "", "Not Found", "<html><title>Uptime: 99%</title></html>",
                    '<svg aria-label="Uptime (24h): 140%"><title>Uptime (24h): 140%</title></svg>',
                    '<svg aria-label="Uptime (24h): -"><title>Uptime (24h): -</title></svg>', 12):
            self.assertIsNone(uptime_kuma.parse_badge_percent(bad), bad)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class LastFiftyChecks(unittest.TestCase):
    def test_shape(self):
        hb = beats(60)
        hb[-2] = {"status": 0, "ping": None, "msg": "timeout", "time": hb[-2]["time"]}
        hb[-3]["status"] = 2
        hb[-4]["status"] = 3
        kuma = FakeKuma(heartbeat={3: hb}, names={3: "Media"})
        kuma.patch(self)
        mon = run(uptime_kuma.read_monitors())[0]
        self.assertEqual(len(mon["beats"]), 50)
        self.assertEqual(mon["beats"][-1], {"status": "up", "ping": 50,
                                            "time": (T0 + timedelta(seconds=59 * 20)).isoformat() + ".000Z"})
        self.assertEqual(mon["beats"][-2], {"status": "down", "ping": None, "time": mon["beats"][-2]["time"]})
        self.assertEqual([b["status"] for b in mon["beats"][-4:-2]], ["maintenance", "degraded"])
        self.assertEqual(mon["beats"][0]["time"], (T0 + timedelta(seconds=10 * 20)).isoformat() + ".000Z")
        self.assertEqual(set(mon["beats"][0]), {"status", "ping", "time"})

    def test_kuma_iso(self):
        self.assertEqual(uptime_kuma.kuma_iso("2026-10-06 01:56:33.664"), "2026-10-06T01:56:33.664Z")
        self.assertEqual(uptime_kuma.kuma_iso("2026-10-06 01:56:33"), "2026-10-06T01:56:33.000Z")
        for bad in (None, "", "yesterday", 5):
            self.assertIsNone(uptime_kuma.kuma_iso(bad))

    def test_the_past_day_is_read_and_there_is_no_720_key(self):
        kuma = FakeKuma(heartbeat={3: beats(5)}, names={3: "Media"})
        kuma.patch(self)
        mon = run(uptime_kuma.read_monitors())[0]
        self.assertEqual(mon["uptime_24h"], 99.39)
        self.assertIsNone(mon["uptime_30d"], "never 0 for a key that does not exist")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class UptimeWindows(unittest.TestCase):
    def setUp(self):
        self.redis = FakeRedis()
        self.kuma = FakeKuma(badges={(3, 720): SAMPLES["3/720"]["svg"],
                                     (3, 100000): SAMPLES["4/100000"]["svg"],
                                     (4, 720): httpx.ReadTimeout("slow")})
        self.kuma.patch(self, self.redis)

    def read(self):
        return run(uptime_kuma.read_uptime([{"id": 3, "uptime_24h": 99.39}, {"id": 4, "uptime_24h": 100.0}]))

    def badge_calls(self):
        return [c for c in self.kuma.calls if "/api/badge/" in c]

    def test_windows(self):
        self.assertEqual(self.read(), {3: {"24h": 99.39, "30d": 99.72, "all": 98.09},
                                       4: {"24h": 100.0, "30d": None, "all": None}})
        self.assertEqual(sorted(c.split("/api/badge/")[1] for c in self.badge_calls()),
                         ["3/uptime/100000", "3/uptime/720", "4/uptime/100000", "4/uptime/720"])

    def test_cached_in_redis_for_ten_minutes(self):
        self.read()
        self.assertEqual(len(self.badge_calls()), 4)
        self.assertEqual(json.loads(self.redis.store["webservarr:cache:kuma-uptime:3:720"]), {"pct": 99.72})
        self.redis.now += 100
        self.assertEqual(self.read()[3]["30d"], 99.72)
        self.assertEqual(len(self.badge_calls()), 4, "a second worker's read comes from Redis")
        self.redis.now += 498      # 598 s: the two misses are asked again, the figures are not
        self.read()
        self.assertEqual(len(self.badge_calls()), 6)
        self.redis.now += 3        # 601 s: the figures are read again
        self.assertEqual(self.read()[3]["30d"], 99.72)
        self.assertEqual(len(self.badge_calls()), 8)

    def test_a_failed_badge_is_asked_again_after_two_minutes(self):
        self.read()
        self.redis.now += 119
        self.read()
        self.assertEqual(sum("4/uptime/720" in c for c in self.badge_calls()), 1)
        self.redis.now += 2
        self.read()
        self.assertEqual(sum("4/uptime/720" in c for c in self.badge_calls()), 2)

    def test_without_redis_it_still_answers(self):
        with mock.patch.object(uptime_kuma, "_redis", mock.AsyncMock(side_effect=OSError("no redis"))):
            self.assertEqual(self.read()[3]["30d"], 99.72)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class LiveChecks(unittest.TestCase):
    """The panel's checks: read past Uptime Kuma's own cache, shared through
    Redis so any number of open panels read Kuma once per BEATS_TTL."""

    def setUp(self):
        self.redis = FakeRedis()
        self.kuma = FakeKuma(heartbeat={3: beats(60)}, names={3: "Media"})
        self.kuma.patch(self, self.redis)

    def heartbeat_calls(self):
        return [c for c in self.kuma.calls if "/heartbeat/" in c]

    def read(self):
        return run(uptime_kuma.read_monitors_live())

    def test_asks_past_kumas_own_cache(self):
        self.assertEqual(self.read()[0]["name"], "Media")
        url = self.heartbeat_calls()[0]
        self.assertEqual(self.kuma.headers[url].get("x-apicache-bypass"), "1")

    def test_the_poller_read_does_not(self):
        run(uptime_kuma.read_monitors())
        self.assertNotIn("x-apicache-bypass", self.kuma.headers[self.heartbeat_calls()[0]])

    def test_a_ttl_just_under_the_panels_interval(self):
        self.assertLess(uptime_kuma.BEATS_TTL, 15, "one viewer asking every 15 s must find it expired")
        self.assertGreaterEqual(uptime_kuma.BEATS_TTL, 10)

    def test_shared_for_the_ttl(self):
        self.read()
        self.redis.now += uptime_kuma.BEATS_TTL - 1
        self.assertEqual(self.read()[0]["name"], "Media")
        self.assertEqual(len(self.heartbeat_calls()), 1, "a second viewer or worker reads Redis")
        self.redis.now += 1
        self.read()
        self.assertEqual(len(self.heartbeat_calls()), 2, "and the next ask after the TTL reads Kuma again")

    def test_viewers_asking_at_once_read_kuma_once(self):
        self.kuma.delay = 0.3

        async def many():
            return await asyncio.gather(*(uptime_kuma.read_monitors_live() for _ in range(4)))

        answers = run(many())
        self.assertTrue(all(a and a[0]["name"] == "Media" for a in answers), answers)
        self.assertEqual(len(self.heartbeat_calls()), 1)
        self.assertEqual([k for k in self.redis.store if k.endswith(":lock")], [], "the lock is let go")

    def test_not_answering_is_kept_briefly_then_recovers(self):
        self.kuma.down = True
        self.assertIsNone(self.read())
        self.assertIsNone(self.read())
        self.assertEqual(len(self.heartbeat_calls()), 1, "a Kuma that is down is not asked per viewer")
        self.kuma.down = False
        self.redis.now += uptime_kuma.BEATS_MISS_TTL
        self.assertEqual(self.read()[0]["name"], "Media")
        self.assertEqual(len(self.heartbeat_calls()), 2)

    def test_a_new_address_is_a_new_copy(self):
        self.read()
        with mock.patch.object(uptime_kuma, "_get_config", return_value={"url": "http://other.invalid", "slug": "home"}):
            self.read()
        self.assertEqual(len(self.heartbeat_calls()), 2)

    def test_without_redis_it_reads_kuma(self):
        with mock.patch.object(uptime_kuma, "_redis", mock.AsyncMock(side_effect=OSError("no redis"))):
            self.assertEqual(self.read()[0]["name"], "Media")
            self.read()
        self.assertEqual(len(self.heartbeat_calls()), 2)

    def test_not_set_up_asks_nothing(self):
        with mock.patch.object(uptime_kuma, "_get_config", return_value={"url": "", "slug": ""}):
            self.assertIsNone(self.read())
        self.assertEqual(self.kuma.calls, [])


def signed_up(case):
    p = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
    p.start()
    case.addCleanup(p.stop)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ServiceStatusRoute(unittest.TestCase):
    def setUp(self):
        signed_up(self)
        self.Session = helpers.make_sessionmaker()
        self.client = helpers.api_client(self.Session, user=helpers.MEMBER)
        self.addCleanup(helpers.reset_overrides)
        db = self.Session()
        helpers.put(db, "monitor.9.enabled", "false")
        db.commit()
        db.close()

    def get(self, kuma):
        kuma.patch(self)
        return self.client.get("/api/integrations/service-status")

    def test_each_monitor_carries_its_checks_and_uptime(self):
        kuma = FakeKuma(heartbeat={3: beats(60), 9: beats(60, status=0, ping=None)},
                        names={3: "Media", 9: "Secret Box"},
                        badges={(3, 720): SAMPLES["3/720"]["svg"], (3, 100000): SAMPLES["4/100000"]["svg"]})
        r = self.get(kuma)
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual([m["name"] for m in body], ["Media"], "a monitor switched off is never sent")
        self.assertNotIn("Secret Box", r.text)
        self.assertFalse(any("/api/badge/9/" in c for c in kuma.calls), "nor its badges read")
        mon = body[0]
        self.assertEqual(len(mon["beats"]), 50)
        self.assertEqual(mon["uptime"], {"24h": 99.39, "30d": 99.72, "all": 98.09})
        self.assertEqual(mon["uptime_30d"], 99.72)

    def test_two_viewers_share_one_read_of_the_checks(self):
        kuma = FakeKuma(heartbeat={3: beats(60)}, names={3: "Media"})
        self.get(kuma)
        r = self.client.get("/api/integrations/service-status")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(sum("/heartbeat/" in c for c in kuma.calls), 1)

    def test_uptime_kuma_not_answering_is_503(self):
        r = self.get(FakeKuma(down=True))
        self.assertEqual(r.status_code, 503)
        self.assertNotIn("http://", r.text)

    def test_not_set_up_is_an_empty_list(self):
        with mock.patch.object(uptime_kuma, "_get_config", return_value={"url": "", "slug": ""}):
            r = self.client.get("/api/integrations/service-status")
        self.assertEqual((r.status_code, r.json()), (200, []))

    def test_needs_a_session(self):
        from app.dependencies import get_current_user
        from app.main import app
        app.dependency_overrides.pop(get_current_user, None)
        FakeKuma(heartbeat={3: beats(5)}, names={3: "Media"}).patch(self)
        r = self.client.get("/api/integrations/service-status", headers={"Cookie": ""})
        self.assertEqual(r.status_code, 401)
        self.assertNotIn("Media", r.text)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class PublicSummaryStaysAggregate(unittest.TestCase):
    """The public login-page line gets none of the panel's detail."""

    def setUp(self):
        signed_up(self)
        self.Session = helpers.make_sessionmaker()
        self.client = helpers.api_client(self.Session)
        self.addCleanup(helpers.reset_overrides)

    def test_no_checks_no_uptime_no_other_names(self):
        kuma = FakeKuma(heartbeat={3: beats(60), 4: beats(60)}, names={3: "Media", 4: "Requests"},
                        badges={(3, 720): SAMPLES["3/720"]["svg"]})
        kuma.patch(self)
        r = self.client.get("/api/integrations/status-summary")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"status": "online", "down_service": None})
        for leak in ("beats", "uptime", "ping", "Media", "Requests", "99."):
            self.assertNotIn(leak, r.text)
        self.assertFalse(any("/api/badge/" in c for c in kuma.calls), "the public line never reads badges")

    def test_not_answering_is_unknown(self):
        FakeKuma(down=True).patch(self)
        self.assertEqual(self.client.get("/api/integrations/status-summary").json(),
                         {"status": "unknown", "down_service": None})

    def test_many_anonymous_calls_read_uptime_kuma_once(self):
        """The public line reads the shared live copy: concurrent callers
        wait for the one read in flight, later ones reuse its copy."""
        from app.main import app
        real_client = httpx.AsyncClient
        kuma = FakeKuma(heartbeat={3: beats(5), 4: beats(5, status=0)}, names={3: "Media", 4: "Requests"},
                        delay=0.3)
        kuma.patch(self)

        async def calls():
            async with real_client(transport=httpx.ASGITransport(app=app), base_url="https://test") as c:
                first = await asyncio.gather(*(c.get("/api/integrations/status-summary") for _ in range(8)))
                later = await c.get("/api/integrations/status-summary")
                return list(first) + [later]

        answers = run(calls())
        self.assertEqual({r.status_code for r in answers}, {200})
        self.assertEqual({json.dumps(r.json()) for r in answers},
                         {json.dumps({"status": "issues", "down_service": "Requests"})})
        self.assertEqual(sum("/heartbeat/" in c for c in kuma.calls), 1, kuma.calls)

    def test_a_failed_read_is_shared_too(self):
        kuma = FakeKuma(down=True)
        kuma.patch(self)
        for _ in range(3):
            self.assertEqual(self.client.get("/api/integrations/status-summary").json(),
                             {"status": "unknown", "down_service": None})
        self.assertEqual(sum("/heartbeat/" in c for c in kuma.calls), 1, kuma.calls)


if __name__ == "__main__":
    unittest.main()
