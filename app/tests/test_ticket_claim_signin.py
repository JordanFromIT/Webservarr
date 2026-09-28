"""
Claiming legacy tickets by email, end to end through the real sign-in routes.

The sign-in routes hand claim_legacy_tickets the session data they built,
where email_verified is a Python bool; the session stored in Redis holds the
string "true" or "false". Both forms must count. These tests run the real
Plex-direct and Authentik callbacks with claim_legacy_tickets NOT mocked, a
real SessionManager over an in-memory Redis stand-in, and then read the
tickets list with the stored session's cookie: a verified email claims the
legacy ticket filed under it, an unverified one never does.
"""
import asyncio
import unittest
from unittest import mock

try:
    import httpx
    from fastapi import FastAPI

    from app.auth import session_manager
    from app.config import settings
    from app.database import get_db
    from app.limiter import limiter
    from app.models import Ticket
    from app.routers import auth as oidc_auth
    from app.routers import plex_auth, tickets
    from app.tests.test_plex_pin_claim import NONCE, PIN, FakePlexResponse
    from app.tests.test_push import make_session_factory
    RealAsyncClient = httpx.AsyncClient
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False


class FakeRedis:
    """Strings and hashes with Redis's types: hash fields come back as bytes."""

    def __init__(self):
        self.data = {}
        self.hashes = {}

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
        return sum((self.data.pop(k, None) is not None) + (self.hashes.pop(k, None) is not None)
                   for k in keys)

    async def exists(self, key):
        return int(key in self.hashes or key in self.data)

    async def expire(self, key, ttl):
        return True

    async def sadd(self, key, *members):
        return len(members)

    async def hset(self, key, mapping):
        self.hashes.setdefault(key, {}).update(
            {k.encode(): (v if isinstance(v, bytes) else str(v).encode()) for k, v in mapping.items()})

    async def hgetall(self, key):
        return dict(self.hashes.get(key, {}))


class _SignInHarness(unittest.TestCase):
    """The sign-in routers and the tickets router, one in-memory database,
    and the real session store over FakeRedis."""

    def setUp(self):
        self.Session = make_session_factory()
        self.redis = FakeRedis()

        self.app = FastAPI()
        self.app.state.limiter = limiter
        self.app.include_router(plex_auth.router, prefix="/auth")
        self.app.include_router(oidc_auth.router, prefix="/auth")
        self.app.include_router(tickets.router, prefix="/api")

        def _db():
            db = self.Session()
            try:
                yield db
            finally:
                db.close()
        self.app.dependency_overrides[get_db] = _db
        self._limiter_was = limiter.enabled
        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", self._limiter_was)

        for p in (
            mock.patch.object(session_manager, "get_redis", mock.AsyncMock(return_value=self.redis)),
            mock.patch.object(oidc_auth, "_user_has_server_access", mock.AsyncMock(return_value=True)),
            mock.patch.object(oidc_auth, "_is_plex_server_owner", mock.AsyncMock(return_value=False)),
            mock.patch.object(plex_auth, "_user_has_server_access", mock.AsyncMock(return_value=True)),
            mock.patch.object(plex_auth, "_is_plex_server_owner", mock.AsyncMock(return_value=False)),
            mock.patch.object(plex_auth.seerr, "authenticate_with_plex_token", mock.AsyncMock(return_value=None)),
            mock.patch.object(plex_auth, "_plex_auth_enabled", return_value=True),
            mock.patch.object(plex_auth, "_get_plex_client_id", return_value="client-id"),
            mock.patch.object(oidc_auth, "_authentik_auth_enabled", return_value=True),
        ):
            p.start()
            self.addCleanup(p.stop)

    def legacy_ticket(self, email):
        db = self.Session()
        try:
            t = Ticket(title="Old", description="D", category="other", status="open", is_public=False,
                       creator_username="old-name", creator_name="Old", creator_email=email)
            db.add(t)
            db.commit()
            return t.id
        finally:
            db.close()

    def identity_of(self, ticket_id):
        db = self.Session()
        try:
            return db.query(Ticket).filter(Ticket.id == ticket_id).one().creator_identity
        finally:
            db.close()

    def plex_tv(self, account):
        """plex.tv: an authorized PIN, and this account."""

        class Client:
            def __init__(self, *a, **kw):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def get(self, url, headers=None):
                if "/pins/" in url:
                    return FakePlexResponse(200, {"authToken": "plex-token"})
                return FakePlexResponse(200, account)

        p = mock.patch.object(httpx, "AsyncClient", Client)
        p.start()
        self.addCleanup(p.stop)

    def drive(self, coro_fn):
        async def go():
            transport = httpx.ASGITransport(app=self.app)
            async with RealAsyncClient(transport=transport, base_url="https://test") as client:
                return await coro_fn(client)
        return asyncio.run(go())

    def my_tickets(self, client, response):
        """The tickets list read back with the session the sign-in stored."""
        sid = response.cookies.get(settings.session_cookie_name)
        self.assertTrue(sid, response.text)
        return client.get("/api/tickets", cookies={settings.session_cookie_name: sid})


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class PlexDirectClaimsByEmail(_SignInHarness):
    ACCOUNT = {"id": 7, "username": "sam", "title": "Sam", "email": "Sam@Example.com", "thumb": ""}

    def sign_in_and_list(self, confirmed):
        self.redis.data[f"plex_pin:{PIN}"] = plex_auth._hash_pin_nonce(NONCE).encode()
        self.plex_tv({**self.ACCOUNT, "confirmed": confirmed})

        async def flow(client):
            r = await client.post("/auth/plex-callback", json={"pin_id": PIN},
                                  cookies={plex_auth.PLEX_PIN_COOKIE: NONCE})
            self.assertEqual(r.status_code, 200, r.text)
            return (await self.my_tickets(client, r)).json()["tickets"]
        return self.drive(flow)

    def test_a_confirmed_plex_email_claims_the_legacy_ticket(self):
        tid = self.legacy_ticket("sam@example.com")
        listed = self.sign_in_and_list(confirmed=True)
        self.assertEqual(self.identity_of(tid), "plex:7")
        self.assertEqual([(t["id"], t["is_own"]) for t in listed], [(tid, True)])

    def test_an_unconfirmed_plex_email_claims_nothing(self):
        tid = self.legacy_ticket("sam@example.com")
        listed = self.sign_in_and_list(confirmed=False)
        self.assertIsNone(self.identity_of(tid))
        self.assertEqual(listed, [])


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class AuthentikClaimsByEmail(_SignInHarness):
    USERINFO = {"sub": "oidc-sub-1", "preferred_username": "bob", "name": "Bob",
                "email": "bob@example.com", "plex_token": "plex-token"}

    def sign_in_and_list(self, userinfo, plex_account):
        userinfo = dict(userinfo)

        class OIDC:
            redirect_uri = ""

            async def exchange_code_for_token(self, code, code_verifier=""):
                return {"access_token": "at", "id_token": ""}

            async def get_userinfo(self, access_token):
                return userinfo

        for p in (
            mock.patch.object(oidc_auth, "get_oidc_client", return_value=OIDC()),
            mock.patch.object(session_manager, "consume_oidc_flow",
                              mock.AsyncMock(return_value={"state": "st", "code_verifier": "", "nonce": ""})),
            mock.patch.object(oidc_auth.seerr, "authenticate_with_plex_token", mock.AsyncMock(return_value=None)),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.plex_tv(plex_account)

        async def flow(client):
            r = await client.get("/auth/callback", params={"code": "c", "state": "st"},
                                 cookies={oidc_auth.OIDC_FLOW_COOKIE: "flow"})
            self.assertEqual(r.status_code, 302, r.text)
            return (await self.my_tickets(client, r)).json()["tickets"]
        return self.drive(flow)

    def test_a_verified_oidc_email_claims_the_legacy_ticket(self):
        tid = self.legacy_ticket("bob@example.com")
        listed = self.sign_in_and_list({**self.USERINFO, "email_verified": True},
                                       {"id": 123456, "email": "someone@else.example", "confirmed": False})
        self.assertEqual(self.identity_of(tid), "plex:123456")
        self.assertEqual([(t["id"], t["is_own"]) for t in listed], [(tid, True)])

    def test_the_plex_accounts_confirmed_email_claims_it_too(self):
        tid = self.legacy_ticket("bob@example.com")
        self.sign_in_and_list({**self.USERINFO, "email_verified": False},
                              {"id": 123456, "email": "Bob@Example.com", "confirmed": True})
        self.assertEqual(self.identity_of(tid), "plex:123456")

    def test_an_unverified_email_claims_nothing(self):
        tid = self.legacy_ticket("bob@example.com")
        listed = self.sign_in_and_list({**self.USERINFO, "email_verified": False},
                                       {"id": 123456, "email": "bob@example.com", "confirmed": False})
        self.assertIsNone(self.identity_of(tid))
        self.assertEqual(listed, [])


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class VerifiedFlagInEveryForm(unittest.TestCase):
    def test_the_bool_and_the_stored_string_both_count(self):
        from app.routers.tickets import _email_verified
        for value in (True, "true", "True", "TRUE", " true ", b"true"):
            self.assertTrue(_email_verified({"email_verified": value}), value)
        for value in (False, "false", "", None, "yes", 1, b"false"):
            self.assertFalse(_email_verified({"email_verified": value}), value)
        self.assertFalse(_email_verified({}))


if __name__ == "__main__":
    unittest.main()
