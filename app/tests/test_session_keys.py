"""
Redis never holds a session id someone could sign in with.

The embedded Redis persists to data/redis, so sessions survive restarts. Its
keys and indexes name a session by the SHA-256 of its id (auth.session_key),
never the cookie value: a copy of that folder cannot be replayed as a cookie.
Sign-in, update, logout, revoke-others and the absolute lifetime all keep
working through the hashed keys.

Run against this run's own Redis (app/tests/__init__.py), never the instance's.
"""
import asyncio
import time
import unittest
import uuid
from unittest import mock

try:
    import redis.asyncio as aioredis

    from app.auth import session_key, session_manager
    from app.config import settings
    from app.routers import kavita_proxy
    from app.tests import is_test_redis
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class HashedSessionKeys(unittest.TestCase):
    def setUp(self):
        self.assertTrue(is_test_redis(settings.redis_url), settings.redis_url)   # never the live db
        self.user_id = f"test-keys-{uuid.uuid4().hex[:8]}"
        self.user = {"user_id": self.user_id, "username": "sam", "email": "sam@example.com",
                     "auth_method": "simple", "is_admin": "false"}

    def run_redis(self, coro_fn):
        async def go():
            r = aioredis.from_url(settings.redis_url)
            try:
                with mock.patch.object(session_manager, "get_redis", mock.AsyncMock(return_value=r)):
                    return await coro_fn(r)
            finally:
                keys = [k async for k in r.scan_iter(match=f"*{self.user_id}*")]
                keys += [session_key(s) for s in getattr(self, "sids", ())]
                keys += [k async for k in r.scan_iter(match="kavita_ok:*")]
                if keys:
                    await r.delete(*keys)
                await r.aclose()
        return asyncio.run(go())

    async def everything_stored(self, r):
        """Every key, and every member of every set, as one list of strings."""
        found = []
        async for key in r.scan_iter(count=500):
            found.append(key.decode())
            if await r.type(key) == b"set":
                found += [m.decode() for m in await r.smembers(key)]
        return found

    def assertNowhere(self, sid, stored):
        self.assertEqual([s for s in stored if sid in s], [])

    def test_create_and_update_store_no_raw_session_id(self):
        sid = session_manager.generate_session_id()
        self.sids = [sid]

        async def go(r):
            await session_manager.create_session(sid, self.user)
            await session_manager.update_session(sid, {"kavita_token": "jwt", "kavita_return": "/books"})
            return await self.everything_stored(r), await r.hgetall(session_key(sid))

        stored, fields = self.run_redis(go)
        self.assertNowhere(sid, stored)
        self.assertIn(session_key(sid), stored)
        self.assertEqual((fields[b"username"], fields[b"kavita_token"]), (b"sam", b"jwt"))

    def test_kavita_visibility_shortcut_stores_no_raw_session_id(self):
        sid = session_manager.generate_session_id()
        self.assertNotIn(sid, kavita_proxy._item_ok_key(sid, "jwt", "series", 7))

        async def go(r):
            with mock.patch.object(kavita_proxy.kavita_api, "items_are_visible",
                                   mock.AsyncMock(return_value=True)):
                await kavita_proxy._require_visible_items([("series", 7)], "http://kavita", "jwt", sid)
            return await self.everything_stored(r), [k async for k in r.scan_iter(match="kavita_ok:*")]

        stored, shortcuts = self.run_redis(go)
        self.assertEqual(len(shortcuts), 1)             # the check was kept, under a hashed name
        self.assertNowhere(sid, stored)

    def test_get_update_delete_round_trip(self):
        sid = session_manager.generate_session_id()
        self.sids = [sid]

        async def go(r):
            await session_manager.create_session(sid, self.user)
            got = await session_manager.get_session(sid)
            await session_manager.update_session(sid, {"kavita_return": "/books/4"})
            updated = await session_manager.get_session(sid)
            ttl = await r.ttl(session_key(sid))
            await session_manager.delete_session(sid)
            return got, updated, ttl, await session_manager.get_session(sid)

        got, updated, ttl, after_logout = self.run_redis(go)
        self.assertEqual(got["username"], "sam")
        self.assertEqual(updated["kavita_return"], "/books/4")
        self.assertGreater(ttl, settings.session_max_age - 10)
        self.assertIsNone(after_logout)

    def test_revoking_other_sessions_spares_the_current_one(self):
        current, other, third = (session_manager.generate_session_id() for _ in range(3))
        self.sids = [current, other, third]

        async def go(r):
            for sid in self.sids:
                await session_manager.create_session(sid, self.user)
            revoked = await session_manager.delete_user_sessions("simple", self.user_id,
                                                                 exclude_session_id=current)
            return revoked, [await session_manager.get_session(s) for s in self.sids]

        revoked, sessions = self.run_redis(go)
        self.assertEqual(revoked, 2)
        self.assertIsNotNone(sessions[0])
        self.assertEqual(sessions[1:], [None, None])

    def test_absolute_lifetime_ceiling_still_enforced(self):
        sid = session_manager.generate_session_id()
        self.sids = [sid]

        async def go(r):
            await session_manager.create_session(sid, self.user)
            too_old = int(time.time()) - session_manager.absolute_max_age - 60
            await r.hset(session_key(sid), "created_at", str(too_old))
            return await session_manager.get_session(sid), await r.exists(session_key(sid))

        got, exists = self.run_redis(go)
        self.assertIsNone(got)
        self.assertEqual(exists, 0)


if __name__ == "__main__":
    unittest.main()
