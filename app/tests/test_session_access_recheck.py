"""
A signed-in Plex session is asked again, at most once a day, whether its
account can still reach the server (audit F1).

Sessions persist across restarts for up to 30 days, so a member taken off the
share used to keep using the site until then. get_current_user now re-asks
Plex membership once the session's last check (or its sign-in) is a day old:
"not_member" or "token_rejected" ends the session and forgets the kept Kavita
key; "member" records the check; "unknown" (Plex down) keeps the session.
Recent sign-ins and sessions without a Plex token make no Plex call, and
concurrent requests never ask twice.

Run against this run's own Redis (app/tests/__init__.py), never the instance's.
"""
import asyncio
import time
import unittest
import uuid
from unittest import mock

try:
    import redis.asyncio as aioredis
    from fastapi import HTTPException

    from app import dependencies
    from app.auth import session_digest, session_key, session_manager
    from app.config import settings
    from app.routers import auth as oidc_auth
    from app.services import kavita_keys
    from app.tests import is_test_redis
    from app.tests.helpers import make_sessionmaker
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

DAY = 24 * 60 * 60


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SessionAccessRecheck(unittest.TestCase):
    def setUp(self):
        self.assertTrue(is_test_redis(settings.redis_url), settings.redis_url)   # never the live db
        self.plex_id = f"99{uuid.uuid4().int % 10**8}"
        self.sids = []

    def user(self, **extra):
        user = {"user_id": self.plex_id, "username": "sam", "auth_method": "plex",
                "is_admin": "false", "plex_token": "plex-token", "plex_account_id": self.plex_id}
        user.update(extra)
        return user

    def run_redis(self, membership, coro_fn):
        """Run coro_fn(r, calls, forget) with Plex membership answering
        `membership` (a string, or an async function) and Kavita's forget
        recorded, against the test Redis."""
        calls = []

        async def answer(token, db):
            calls.append(token)
            if callable(membership):
                return await membership()
            return membership

        async def go():
            r = aioredis.from_url(settings.redis_url)
            forget = mock.Mock()
            try:
                with mock.patch.object(session_manager, "get_redis", mock.AsyncMock(return_value=r)), \
                        mock.patch.object(oidc_auth, "_server_membership", side_effect=answer), \
                        mock.patch.object(kavita_keys, "forget", forget), \
                        mock.patch("app.database.SessionLocal", make_sessionmaker()):
                    return await coro_fn(r, calls, forget)
            finally:
                keys = [session_key(s) for s in self.sids]
                keys += [f"session_access_check:{session_digest(s)}" for s in self.sids]
                keys += [k async for k in r.scan_iter(match=f"user_sessions:*{self.plex_id}*")]
                await r.delete(*keys)
                await r.aclose()
        return asyncio.run(go())

    async def new_session(self, r, age_s=0, **extra):
        sid = session_manager.generate_session_id()
        self.sids.append(sid)
        await session_manager.create_session(sid, self.user(**extra))
        if age_s:
            await r.hset(session_key(sid), "created_at", str(int(time.time()) - age_s))
        return sid

    async def current(self, sid):
        """get_current_user's answer: the session dict, or the HTTP status."""
        try:
            return await dependencies.get_current_user(session_id=sid)
        except HTTPException as exc:
            return exc.status_code

    def test_recent_sign_in_makes_no_plex_call(self):
        async def go(r, calls, forget):
            sid = await self.new_session(r)
            user = await self.current(sid)
            return user["username"], calls
        self.assertEqual(self.run_redis("not_member", go), ("sam", []))

    def test_session_without_plex_token_is_never_asked(self):
        async def go(r, calls, forget):
            sid = await self.new_session(r, age_s=3 * DAY, plex_token="", auth_method="simple")
            user = await self.current(sid)
            return user["username"], calls
        self.assertEqual(self.run_redis("not_member", go), ("sam", []))

    def test_member_is_recorded_and_not_asked_again_that_day(self):
        async def go(r, calls, forget):
            sid = await self.new_session(r, age_s=2 * DAY)
            first = await self.current(sid)
            second = await self.current(sid)
            checked = await r.hget(session_key(sid), "access_checked_at")
            return first["username"], second["username"], len(calls), checked is not None
        self.assertEqual(self.run_redis("member", go), ("sam", "sam", 1, True))

    def test_member_is_asked_again_once_the_last_check_is_a_day_old(self):
        async def go(r, calls, forget):
            sid = await self.new_session(r, age_s=5 * DAY)
            await r.hset(session_key(sid), "access_checked_at", str(int(time.time()) - DAY - 60))
            user = await self.current(sid)
            return user["username"], len(calls)
        self.assertEqual(self.run_redis("member", go), ("sam", 1))

    def removed(self, membership):
        async def go(r, calls, forget):
            sid = await self.new_session(r, age_s=2 * DAY)
            status = await self.current(sid)
            gone = not await r.exists(session_key(sid))
            return status, gone, forget.call_args_list
        return self.run_redis(membership, go)

    def test_not_member_ends_the_session_and_forgets_the_kavita_key(self):
        status, gone, forgot = self.removed("not_member")
        self.assertEqual((status, gone), (401, True))
        self.assertEqual(forgot, [mock.call(f"plex:{self.plex_id}")])

    def test_rejected_token_ends_the_session(self):
        status, gone, forgot = self.removed("token_rejected")
        self.assertEqual((status, gone), (401, True))
        self.assertEqual(forgot, [mock.call(f"plex:{self.plex_id}")])

    def test_plex_down_keeps_the_session_and_waits_a_day(self):
        async def go(r, calls, forget):
            sid = await self.new_session(r, age_s=2 * DAY)
            first = await self.current(sid)
            second = await self.current(sid)
            return first["username"], second["username"], len(calls), forget.called
        self.assertEqual(self.run_redis("unknown", go), ("sam", "sam", 1, False))

    def test_concurrent_requests_ask_plex_once(self):
        async def slow():
            await asyncio.sleep(0.05)
            return "member"

        async def go(r, calls, forget):
            sid = await self.new_session(r, age_s=2 * DAY)
            users = await asyncio.gather(*(self.current(sid) for _ in range(8)))
            return [u["username"] for u in users], len(calls)
        names, asked = self.run_redis(slow, go)
        self.assertEqual((names, asked), (["sam"] * 8, 1))

    def test_optional_user_is_none_once_access_is_gone(self):
        async def go(r, calls, forget):
            sid = await self.new_session(r, age_s=2 * DAY)
            return await dependencies.get_current_user_optional(session_id=sid)
        self.assertIsNone(self.run_redis("not_member", go))


if __name__ == "__main__":
    unittest.main()
