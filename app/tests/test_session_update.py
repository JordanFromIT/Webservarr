"""
session_manager.update_session never recreates a session that is gone.

It merges fields (the Kavita sign-in, the hand-off's return page and time, the
player's server) into a live session. It used to ask whether the session
existed and then write, in two round trips: a logout landing between them
left a partial session hash behind, holding only the written fields. The
check and the write are now one script on the Redis side.

Run against the FakeRedis the sign-in tests use, and against this run's own
Redis (app/tests/__init__.py), so the script itself is executed for real.
"""
import asyncio
import unittest
import uuid
from unittest import mock

try:
    import redis.asyncio as aioredis

    from app.auth import session_manager
    from app.config import settings
    from app.tests import is_test_redis
    from app.tests.test_ticket_claim_signin import FakeRedis
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False
    FakeRedis = object


class _LogoutAfterRead(FakeRedis):
    """A logout lands right after any separate read of a session, the
    moment a check-then-write would have been interrupted."""

    async def exists(self, key):
        found = await super().exists(key)
        await self.delete(key)
        return found


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class UpdateSessionOverFakeRedis(unittest.TestCase):
    def run_with(self, redis, coro_fn):
        with mock.patch.object(session_manager, "get_redis", mock.AsyncMock(return_value=redis)):
            return asyncio.run(coro_fn())

    def test_a_live_session_gets_the_fields(self):
        r = FakeRedis()
        r.hashes["session:sid-1"] = {b"username": b"sam"}
        self.run_with(r, lambda: session_manager.update_session("sid-1", {"kavita_return": "/books", "x": None}))
        self.assertEqual(r.hashes["session:sid-1"],
                         {b"username": b"sam", b"kavita_return": b"/books", b"x": b""})

    def test_a_write_after_the_session_was_deleted_creates_nothing(self):
        r = FakeRedis()
        r.hashes["session:sid-1"] = {b"username": b"sam"}

        async def logout_then_write():
            await session_manager.delete_session("sid-1")
            await session_manager.update_session("sid-1", {"kavita_token": "jwt"})

        self.run_with(r, logout_then_write)
        self.assertNotIn("session:sid-1", r.hashes)

    def test_a_logout_between_check_and_write_leaves_no_partial_session(self):
        # Whole (the logout found no gap) or gone, never just the written fields.
        r = _LogoutAfterRead()
        r.hashes["session:sid-1"] = {b"username": b"sam"}
        self.run_with(r, lambda: session_manager.update_session("sid-1", {"kavita_token": "jwt"}))
        self.assertIn(r.hashes.get("session:sid-1"), (None, {b"username": b"sam", b"kavita_token": b"jwt"}))

    def test_no_fields_is_no_write(self):
        r = mock.AsyncMock()
        self.run_with(r, lambda: session_manager.update_session("sid-1", {}))
        self.assertEqual(r.mock_calls, [])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class UpdateSessionOverRealRedis(unittest.TestCase):
    """The script as Redis runs it, in this run's own database."""

    def setUp(self):
        self.assertTrue(is_test_redis(settings.redis_url), settings.redis_url)   # never the live db
        self.key = f"session:test-update-{uuid.uuid4().hex[:8]}"

    def run_redis(self, coro_fn):
        async def go():
            r = aioredis.from_url(settings.redis_url)
            try:
                with mock.patch.object(session_manager, "get_redis", mock.AsyncMock(return_value=r)):
                    return await coro_fn(r)
            finally:
                await r.delete(self.key)
                await r.close()
        return asyncio.run(go())

    def test_a_live_session_is_merged_and_its_ttl_renewed(self):
        sid = self.key.split(":", 1)[1]

        async def go(r):
            await r.hset(self.key, mapping={"username": "sam"})
            await r.expire(self.key, 30)
            await session_manager.update_session(sid, {"kavita_return": "/books/4", "kavita_connect_at": 123})
            return await r.hgetall(self.key), await r.ttl(self.key)

        fields, ttl = self.run_redis(go)
        self.assertEqual(fields, {b"username": b"sam", b"kavita_return": b"/books/4", b"kavita_connect_at": b"123"})
        self.assertGreater(ttl, settings.session_max_age - 10)

    def test_a_missing_session_is_not_created(self):
        sid = self.key.split(":", 1)[1]

        async def go(r):
            await session_manager.update_session(sid, {"kavita_token": "jwt"})
            return await r.exists(self.key)

        self.assertEqual(self.run_redis(go), 0)


if __name__ == "__main__":
    unittest.main()
