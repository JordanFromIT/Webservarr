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


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class OnePinOneSession(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
