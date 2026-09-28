"""
One Plex PIN signs in once, however many callbacks race for it.

The login page used to call POST /auth/plex-callback twice for one PIN (the
popup's message and the popup-closed poll). The route checked the PIN's
browser binding, then made two Plex round trips, and only then deleted the
PIN: two calls close together both passed the check and both created a
session. The route now claims the PIN atomically before any Plex call. The
second caller gets a clean 409, which the page ignores.

The route runs in a small app of its own (the plex_auth router alone), with a
fake Redis and a fake plex.tv whose answers take a moment, so two requests
really are in flight at once.
"""
import asyncio
import unittest
from unittest import mock

try:
    import httpx
    from fastapi import FastAPI

    from app.database import get_db
    from app.limiter import limiter
    from app.routers import plex_auth
    # The fake plex.tv replaces httpx.AsyncClient for the route; the test's own
    # client is the real one, taken before any patch.
    RealAsyncClient = httpx.AsyncClient
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

PIN = 424242
NONCE = "a-browser-nonce"


class FakeRedis:
    """The calls the route makes, with Redis's semantics, on one event loop."""

    def __init__(self):
        self.data = {}

    async def get(self, key):
        return self.data.get(key)

    async def set(self, key, value, nx=False, ex=None):
        if nx and key in self.data:
            return None
        self.data[key] = value.encode() if isinstance(value, str) else value
        return True

    async def setex(self, key, ttl, value):
        return await self.set(key, value)

    async def delete(self, *keys):
        n = 0
        for key in keys:
            n += self.data.pop(key, None) is not None
        return n


class FakePlexResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = ""

    def json(self):
        return self._payload


def fake_plex(authorized):
    """plex.tv: the PIN (authorized or not yet) and the user, each after a pause."""

    class Client:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, headers=None):
            await asyncio.sleep(0.05)
            if "/pins/" in url:
                return FakePlexResponse(200, {"authToken": "plex-token" if authorized() else None})
            return FakePlexResponse(200, {"id": 7, "username": "sam", "title": "Sam",
                                          "email": "sam@example.com", "thumb": ""})

    return Client


class RouteHarness(unittest.TestCase):
    """The plex_auth router alone, a fake Redis holding one bound PIN, and a
    fake plex.tv."""

    def setUp(self):
        self.redis = FakeRedis()
        self.redis.data[f"plex_pin:{PIN}"] = plex_auth._hash_pin_nonce(NONCE).encode()
        self.create_session = mock.AsyncMock()
        self.authorized = True

        self.app = FastAPI()
        self.app.state.limiter = limiter
        self.app.include_router(plex_auth.router, prefix="/auth")

        def _db():
            yield None
        self.app.dependency_overrides[get_db] = _db
        self._limiter_was = limiter.enabled
        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", self._limiter_was)

        patches = [
            mock.patch.object(plex_auth.session_manager, "get_redis", mock.AsyncMock(return_value=self.redis)),
            mock.patch.object(plex_auth.session_manager, "create_session", self.create_session),
            mock.patch.object(plex_auth, "_plex_auth_enabled", return_value=True),
            mock.patch.object(plex_auth, "_get_plex_client_id", return_value="client-id"),
            mock.patch.object(plex_auth, "_user_has_server_access", mock.AsyncMock(return_value=True)),
            mock.patch.object(plex_auth, "_is_plex_server_owner", mock.AsyncMock(return_value=False)),
            mock.patch.object(plex_auth.seerr, "authenticate_with_plex_token", mock.AsyncMock(return_value=None)),
            mock.patch.object(plex_auth.httpx, "AsyncClient", fake_plex(lambda: self.authorized)),
            # There is no database here; claiming is test_ticket_identity's.
            mock.patch.object(plex_auth, "claim_legacy_tickets", mock.Mock(return_value=0)),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def post(self, n=1):
        async def run():
            transport = httpx.ASGITransport(app=self.app)
            async with RealAsyncClient(transport=transport, base_url="https://test",
                                         cookies={plex_auth.PLEX_PIN_COOKIE: NONCE}) as client:
                return await asyncio.gather(*[client.post("/auth/plex-callback", json={"pin_id": PIN})
                                              for _ in range(n)])
        return asyncio.run(run())


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class OnePinOneSession(RouteHarness):
    def test_two_callbacks_at_once_make_one_session(self):
        results = self.post(2)
        codes = sorted(r.status_code for r in results)
        self.assertEqual(codes, [200, 409], [r.text for r in results])
        self.assertEqual(self.create_session.await_count, 1)
        # The winner consumed the PIN; the loser changed nothing and says so.
        self.assertNotIn(f"plex_pin:{PIN}", self.redis.data)
        loser = next(r for r in results if r.status_code == 409)
        self.assertNotIn("set-cookie", loser.headers)

    def test_a_later_callback_for_a_used_pin_is_refused(self):
        self.assertEqual(self.post()[0].status_code, 200)
        again = self.post()[0]
        self.assertEqual(again.status_code, 400, again.text)
        self.assertEqual(self.create_session.await_count, 1)

    def test_not_yet_authorized_releases_the_claim(self):
        # The page polls while the user is still on plex.tv: each "not yet"
        # must leave the PIN free for the next poll.
        self.authorized = False
        first = self.post()[0]
        self.assertEqual(first.status_code, 400)
        self.assertIn("not yet authorized", first.json()["detail"])
        self.assertIn(f"plex_pin:{PIN}", self.redis.data)
        self.assertNotIn(f"plex_pin_claim:{PIN}", self.redis.data)
        self.authorized = True
        second = self.post()[0]
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(self.create_session.await_count, 1)

    def test_the_binding_is_checked_before_the_claim(self):
        # A caller without this browser's nonce cannot claim (and so block)
        # someone else's PIN: it gets the one generic error, and the PIN stays.
        async def run():
            transport = httpx.ASGITransport(app=self.app)
            async with RealAsyncClient(transport=transport, base_url="https://test",
                                         cookies={plex_auth.PLEX_PIN_COOKIE: "someone-else"}) as client:
                return await client.post("/auth/plex-callback", json={"pin_id": PIN})
        r = asyncio.run(run())
        self.assertEqual(r.status_code, 400)
        self.assertNotIn(f"plex_pin_claim:{PIN}", self.redis.data)
        self.assertIn(f"plex_pin:{PIN}", self.redis.data)
        self.assertEqual(self.post()[0].status_code, 200)



def failing_plex(how):
    """plex.tv failing: 'status' answers 500, 'timeout' times out, 'error'
    cannot be reached."""

    class Client:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def _answer(self):
            if how == "timeout":
                raise httpx.ReadTimeout("slow")
            if how == "error":
                raise httpx.ConnectError("down")
            return FakePlexResponse(500, {})

        async def get(self, url, headers=None):
            return await self._answer()

        async def post(self, url, headers=None, data=None):
            return await self._answer()

    return Client


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class PlexDownIsA503(RouteHarness):
    """plex.tv failing is answered 503 with the reason, never 502 or 504:
    behind Cloudflare those bodies are replaced by its own HTML page, and the
    login page then shows "Unexpected token '<'" (final review M8)."""

    def use(self, how):
        patch = mock.patch.object(plex_auth.httpx, "AsyncClient", failing_plex(how))
        patch.start()
        self.addCleanup(patch.stop)

    def test_the_callback_answers_503(self):
        for how, detail in (("status", "Plex PIN check failed (HTTP 500)"),
                            ("timeout", "Plex API timed out"),
                            ("error", "Failed to contact Plex API")):
            with self.subTest(how):
                self.use(how)
                r = self.post()[0]
                self.assertEqual(r.status_code, 503, r.text)
                self.assertEqual(r.json()["detail"], detail)
                # The PIN stays usable for the next try.
                self.assertIn(f"plex_pin:{PIN}", self.redis.data)
                self.assertNotIn(f"plex_pin_claim:{PIN}", self.redis.data)

    def test_starting_answers_503(self):
        for how, detail in (("status", "Plex PIN creation failed (HTTP 500)"),
                            ("timeout", "Plex API timed out"),
                            ("error", "Failed to contact Plex API")):
            with self.subTest(how):
                self.use(how)

                class Configured:
                    # Plex's address and token are set.
                    def query(self, *a):
                        return self

                    def filter(self, *a):
                        return self

                    def first(self):
                        return mock.Mock(value="set")

                def _db():
                    yield Configured()
                self.app.dependency_overrides[get_db] = _db

                async def run():
                    transport = httpx.ASGITransport(app=self.app)
                    async with RealAsyncClient(transport=transport, base_url="https://test") as client:
                        return await client.post("/auth/plex-start")
                r = asyncio.run(run())
                self.assertEqual(r.status_code, 503, r.text)
                self.assertEqual(r.json()["detail"], detail)

    def test_no_gateway_codes_anywhere_in_the_routes(self):
        import inspect
        import re
        found = re.findall(r"HTTP_50[24]_\w+|status_code=50[24]\b", inspect.getsource(plex_auth))
        self.assertEqual(found, [])


if __name__ == "__main__":
    unittest.main()
