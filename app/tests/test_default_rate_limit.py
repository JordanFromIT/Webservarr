"""
The app-wide default limit (120/minute per address, app/limiter.py) reaches
every route that has no limit of its own, including every route a router
brings in with include_router().

FastAPI 0.137 started keeping each included router as one nested entry in
app.routes, with no endpoint of its own. slowapi 0.1.9's middleware looks
for the endpoint in app.routes only, found none, and so let every router
route through unlimited. A route with its own limit keeps exactly that
limit, and an exempt route (or a mount such as /static) is never limited.

The limits run for real on private in-memory stores, never the shared Redis.
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
    from fastapi import APIRouter, Depends, FastAPI, Request
    from fastapi.testclient import TestClient
    from slowapi import Limiter
    from slowapi.errors import RateLimitExceeded

    from app.limiter import DefaultLimitsMiddleware
    from app.tests.test_integration_health import _private_limiter

DEFAULT_BUDGET = 120
# A trusted front proxy (loopback), so CF-Connecting-IP is believed.
PROXY = ("127.0.0.1", 50000)


def _small_app(include_first):
    """An app shaped like ours, with a 3-a-minute default: a router route
    with no limit, one with its own, an exempt one, and a route on the app
    itself. `include_first` puts the router before or after the app route."""
    limiter = Limiter(key_func=lambda request: "one-client", default_limits=["3/minute"],
                      key_style="endpoint", storage_uri="memory://")
    router = APIRouter(prefix="/api")

    @router.get("/plain")
    async def plain():
        return {}

    @router.get("/own")
    @limiter.limit("5/minute")
    async def own(request: Request):
        return {}

    @router.get("/exempt")
    @limiter.exempt
    async def exempt():
        return {}

    def refuse():
        from fastapi import HTTPException
        raise HTTPException(status_code=401, detail="Not authenticated")

    @router.post("/guarded", dependencies=[Depends(refuse)])
    @limiter.limit("5/minute")
    async def guarded(request: Request):
        return {}

    app = FastAPI()
    app.state.limiter = limiter

    async def on_app():
        return {}
    if include_first:
        app.include_router(router)
        app.get("/on-app")(on_app)
    else:
        app.get("/on-app")(on_app)
        app.include_router(router)

    async def too_many(request, exc):
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=429, content={"detail": str(exc.detail)})
    app.add_exception_handler(RateLimitExceeded, too_many)
    app.add_middleware(DefaultLimitsMiddleware)
    return TestClient(app)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TheMiddleware(unittest.TestCase):
    def codes(self, client, path, n):
        return [client.get(path).status_code for _ in range(n)]

    def test_a_router_route_gets_the_default(self):
        for include_first in (True, False):
            client = _small_app(include_first)
            self.assertEqual(self.codes(client, "/api/plain", 4), [200, 200, 200, 429], include_first)

    def test_a_route_on_the_app_gets_the_default(self):
        self.assertEqual(self.codes(_small_app(True), "/on-app", 4), [200, 200, 200, 429])

    def test_a_route_with_its_own_limit_keeps_only_that(self):
        self.assertEqual(self.codes(_small_app(True), "/api/own", 6), [200] * 5 + [429])

    def test_requests_its_dependencies_refuse_still_count(self):
        # slowapi's decorator counts only after the route's dependencies, so
        # a flood of 401s used to count against nothing.
        client = _small_app(True)
        self.assertEqual([client.post("/api/guarded").status_code for _ in range(7)], [401] * 5 + [429] * 2)

    def test_an_exempt_route_is_never_limited(self):
        self.assertEqual(self.codes(_small_app(True), "/api/exempt", 10), [200] * 10)

    def test_budgets_are_per_route(self):
        client = _small_app(True)
        self.codes(client, "/api/plain", 4)
        self.assertEqual(self.codes(client, "/on-app", 3), [200] * 3)

    def test_an_unknown_path_is_left_to_the_router(self):
        self.assertEqual(self.codes(_small_app(True), "/nowhere", 5), [404] * 5)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TheApp(unittest.TestCase):
    """The same three cases on the real app."""

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        p = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        p.start()
        self.addCleanup(p.stop)
        helpers.api_client(self.Session, user=helpers.MEMBER)
        self.addCleanup(helpers.reset_overrides)
        self.addCleanup(_private_limiter())
        helpers.set_rate_limits(True)
        from app.main import app
        self.client = TestClient(app, client=PROXY)

    def get(self, path, ip="203.0.113.5"):
        return self.client.get(path, headers={"CF-Connecting-IP": ip}).status_code

    def test_a_router_route_without_a_limit_gets_the_default(self):
        codes = [self.get("/api/notifications/unread-count") for _ in range(DEFAULT_BUDGET + 1)]
        self.assertEqual(codes[:DEFAULT_BUDGET], [200] * DEFAULT_BUDGET)
        self.assertEqual(codes[DEFAULT_BUDGET], 429)
        # Another address has a budget of its own.
        self.assertEqual(self.get("/api/notifications/unread-count", ip="203.0.113.6"), 200)

    def test_the_gauges_keep_their_own_larger_budget(self):
        from app.routers import integrations
        budget = int(integrations.SYSTEM_STATS_LIMIT.split("/")[0])
        self.assertGreater(budget, DEFAULT_BUDGET)
        stats = {"configured": False}
        with mock.patch.object(integrations.netdata, "get_system_stats", mock.AsyncMock(return_value=stats)):
            codes = [self.get("/api/integrations/system-stats") for _ in range(budget + 1)]
        self.assertEqual(codes[:budget], [200] * budget)
        self.assertEqual(codes[budget], 429)

    def test_static_files_are_never_limited(self):
        codes = [self.get("/static/webservarr.svg") for _ in range(DEFAULT_BUDGET + 10)]
        self.assertEqual(codes, [200] * (DEFAULT_BUDGET + 10))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class RefusedRequestsCount(unittest.TestCase):
    """A route's own limit counts requests its sign-in or same-origin checks
    refuse, on the real app with no session overrides."""

    def setUp(self):
        p = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(_private_limiter())
        from app.limiter import limiter
        was = limiter.enabled
        self.addCleanup(setattr, limiter, "enabled", was)
        helpers.set_rate_limits(True)
        from app.main import app
        self.client = TestClient(app, client=PROXY)

    def post(self, path, ip="203.0.113.30", **kw):
        return self.client.post(path, headers={"CF-Connecting-IP": ip, **helpers.SAME_ORIGIN}, **kw).status_code

    def test_an_unauthenticated_flood_on_a_write_gets_429(self):
        body = {"mediaType": "movie", "mediaId": 1}
        codes = [self.post("/api/integrations/seerr-request", json=body) for _ in range(31)]
        self.assertEqual(codes[:30], [401] * 30)
        self.assertEqual(codes[30], 429)
        # Another address is unaffected.
        self.assertEqual(self.post("/api/integrations/seerr-request", ip="203.0.113.31", json=body), 401)

    def test_cross_origin_and_malformed_posts_count_too(self):
        codes = [self.client.post("/api/integrations/issues", content=b"{not json",
                                  headers={"CF-Connecting-IP": "203.0.113.32", "Origin": "https://evil.example",
                                           "Content-Type": "application/json"}).status_code for _ in range(31)]
        self.assertEqual(set(codes[:30]) - {401, 403, 422}, set(), codes[:30])
        self.assertEqual(codes[30], 429)

    def test_an_admin_route_flood_without_admin_gets_429(self):
        codes = [self.post("/api/admin/access-requests/1/unblock") for _ in range(31)]
        self.assertEqual(codes[:30], [401] * 30)
        self.assertEqual(codes[30], 429)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class LegitTrafficWithinBudget(unittest.TestCase):
    """Signed-in requests within a route's own budget are counted once."""

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        p = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        p.start()
        self.addCleanup(p.stop)
        helpers.api_client(self.Session, user=helpers.MEMBER)
        self.addCleanup(helpers.reset_overrides)
        self.addCleanup(_private_limiter())
        helpers.set_rate_limits(True)
        from app.main import app
        self.client = TestClient(app, client=PROXY, headers=helpers.SAME_ORIGIN)

    def test_a_signed_in_write_gets_its_whole_budget_once(self):
        with mock.patch("app.routers.integrations._get_plex_token", mock.AsyncMock(return_value=None)):
            codes = [self.client.post("/api/integrations/seerr-request", json={"mediaType": "movie", "mediaId": 1},
                                      headers={"CF-Connecting-IP": "203.0.113.33"}).status_code for _ in range(31)]
        self.assertEqual(codes[:30], [400] * 30)     # not counted twice: 30, not 15
        self.assertEqual(codes[30], 429)


if __name__ == "__main__":
    unittest.main()
