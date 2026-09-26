"""
Moving the Kavita address resets everyone's eBooks connection (Ruling R133).

Kavita keeps no saved secret, but each member's own Kavita sign-in (the JWT
and API key in their session, from the /signin-oidc handshake) is sent by the
proxy to integration.kavita.url. A save or an import that moves that address
to a different place drops every session's Kavita sign-in, so none follows
the address to the new host; members reconnect on their next visit. The
import preview lists the reset and the diff token covers it. Respelling the
address, or clearing it, leaves the sessions alone.

Independently, the proxy sends a token only to the address it was obtained
from (stored with it), so a handshake that finished just before the move, or
a reset that failed, still sends nothing to the new address.

Sessions live in the test Redis database (app/tests/__init__.py), never the
instance's own.
"""
import asyncio
import unittest
import uuid
from unittest import mock

try:
    import httpx
    import redis.asyncio as aioredis

    from app.auth import KAVITA_SESSION_FIELDS, session_manager
    from app.config import settings
    from app.routers import kavita_proxy
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False

KAVITA_A = "http://192.168.1.20:5000"
KAVITA_B = "http://10.66.6.6:5000"          # where the address moves (a literal address: no DNS)
TOKEN = "SYNTH-KAVITA-JWT-4d1a"
API_KEY = "SYNTH-KAVITA-KEY-8e2b"
RESET_NOTE = "Everyone's eBooks connection will be reset (its address changed)"


async def _fresh_redis():
    # A client per call: TestClient runs each request on a new event loop, and
    # a client made on one loop can't be used on another.
    return aioredis.from_url(settings.redis_url)


def run(coro_fn, *args):
    async def go():
        r = await _fresh_redis()
        try:
            return await coro_fn(r, *args)
        finally:
            await r.close()
    return asyncio.run(go())


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class KavitaAddressBase(unittest.TestCase):
    def setUp(self):
        self.assertTrue(settings.redis_url.endswith("/15"), settings.redis_url)   # never the live db
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        helpers.put(self.db, "integration.kavita.url", KAVITA_A)
        # The proxy reads the address through its own short sessions: point
        # them at the in-memory database too.
        self.patches = [mock.patch("app.routers.setup.is_setup_completed", return_value=True),
                        mock.patch.object(session_manager, "get_redis", _fresh_redis),
                        mock.patch.object(kavita_proxy, "SessionLocal", self.Session)]
        for p in self.patches:
            p.start()
        self.client = helpers.api_client(self.Session)
        tag = uuid.uuid4().hex[:8]
        self.sam = f"test-kavita-{tag}-sam"
        self.kim = f"test-kavita-{tag}-kim"
        self.plain = f"test-kavita-{tag}-plain"
        run(self._seed)

    async def _seed(self, r):
        member = {"username": "sam", "email": "sam@example.com", "is_admin": "false", "auth_method": "oidc"}
        await r.hset(f"session:{self.sam}", mapping={**member, "kavita_token": TOKEN,
                                                     "kavita_api_key": API_KEY, "kavita_base": KAVITA_A})
        await r.hset(f"session:{self.kim}", mapping={**member, "username": "kim", "kavita_token": TOKEN + "-kim",
                                                     "kavita_api_key": API_KEY + "-kim", "kavita_base": KAVITA_A})
        await r.hset(f"session:{self.plain}", mapping={**member, "username": "pat"})
        for sid in (self.sam, self.kim, self.plain):
            await r.expire(f"session:{sid}", 600)

    def tearDown(self):
        async def drop(r):
            await r.delete(*(f"session:{s}" for s in (self.sam, self.kim, self.plain)))
        run(drop)
        helpers.reset_overrides()
        for p in self.patches:
            p.stop()
        self.db.close()

    def session(self, sid):
        async def read(r):
            raw = await r.hgetall(f"session:{sid}")
            return {k.decode(): v.decode() for k, v in raw.items()}
        return run(read)

    def assertConnected(self, sid):
        s = self.session(sid)
        self.assertTrue(s.get("kavita_token"), sid)
        self.assertTrue(s.get("kavita_api_key"), sid)

    def assertReset(self, sid):
        s = self.session(sid)
        for field in KAVITA_SESSION_FIELDS:
            self.assertNotIn(field, s, (sid, field))
        self.assertEqual(s.get("email"), "sam@example.com")      # the session itself stays

    def save(self, *pairs):
        return self.client.put("/api/admin/settings/bulk",
                               json={"settings": [{"key": k, "value": v} for k, v in pairs]})

    def importing(self, settings_, dry=True, token=None):
        data = {"format": "webservarr-settings", "format_version": 1, "settings": settings_}
        return self.client.post("/api/admin/settings/import?dry_run=" + ("true" if dry else "false"),
                                json={"data": data, "diff_token": token})

    def proxied_as(self, sid, path="api/series/all"):
        """The upstream requests one member's proxy call makes, their session as stored."""
        from app.dependencies import get_current_user
        from app.main import app
        user = self.session(sid)
        seen = []

        def upstream(request):
            seen.append(request)
            return httpx.Response(200, json=[])

        real_client = httpx.AsyncClient
        admin = app.dependency_overrides[get_current_user]
        app.dependency_overrides[get_current_user] = lambda: user
        try:
            with mock.patch.object(kavita_proxy.httpx, "AsyncClient",
                                   lambda **kw: real_client(transport=httpx.MockTransport(upstream), **kw)):
                r = self.client.get(f"/kavita/{path}")
        finally:
            app.dependency_overrides[get_current_user] = admin
        self.assertEqual(r.status_code, 200, r.text)
        return seen

    def carrying_secrets(self, requests):
        return [str(q.url) for q in requests
                if TOKEN in q.headers.get("authorization", "") or API_KEY in str(q.url)]


class SaveMovesKavita(KavitaAddressBase):
    def test_a_new_address_resets_every_connection(self):
        r = self.save(("integration.kavita.url", KAVITA_B))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertReset(self.sam)
        self.assertReset(self.kim)
        self.assertEqual(self.session(self.plain).get("username"), "pat")

    def test_after_the_move_the_old_token_never_reaches_the_new_host(self):
        # The control first: before the move the member's token goes to Kavita.
        before = self.proxied_as(self.sam)
        self.assertTrue(before[0].url.host == "192.168.1.20" and self.carrying_secrets(before))
        self.assertEqual(self.save(("integration.kavita.url", KAVITA_B)).status_code, 200)
        after = self.proxied_as(self.sam) + self.proxied_as(self.sam, "api/image/series-cover")
        self.assertTrue(all(q.url.host == "10.66.6.6" for q in after))
        self.assertEqual(self.carrying_secrets(after), [])
        self.assertTrue(all("authorization" not in q.headers for q in after))

    def test_the_same_address_written_differently_keeps_the_connections(self):
        for same in (KAVITA_A + "/", "HTTP://192.168.1.20:5000"):
            r = self.save(("integration.kavita.url", same))
            self.assertEqual(r.status_code, 200, r.text)
            self.assertConnected(self.sam)
            self.assertConnected(self.kim)

    def test_clearing_the_address_keeps_the_connections(self):
        self.assertEqual(self.save(("integration.kavita.url", "")).status_code, 200)
        self.assertConnected(self.sam)

    def test_an_unrelated_save_keeps_the_connections(self):
        self.assertEqual(self.save(("branding.app_name", "Cinema")).status_code, 200)
        self.assertConnected(self.sam)

    def test_a_refused_save_resets_nothing(self):
        r = self.save(("integration.kavita.url", KAVITA_B), ("branding.app_name", "\x00"))
        self.assertEqual(r.status_code, 422, r.text)
        self.assertConnected(self.sam)

    def test_a_failed_reset_does_not_fail_the_save(self):
        broken = mock.AsyncMock(side_effect=ConnectionError("redis down"))
        with mock.patch.object(session_manager, "clear_kavita_connections", broken), \
             self.assertLogs("app.routers.admin_settings", level="WARNING") as logs:
            r = self.save(("integration.kavita.url", KAVITA_B))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("weren't reset", logs.output[0])
        # The token is still in the session, but it belongs to the old address:
        # the proxy does not send it to the new one.
        self.assertConnected(self.sam)
        self.assertEqual(self.carrying_secrets(self.proxied_as(self.sam)), [])


class ImportMovesKavita(KavitaAddressBase):
    def test_the_preview_lists_the_reset(self):
        r = self.importing({"integration.kavita.url": KAVITA_B})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["changes"], [
            {"key": "integration.kavita.url", "old": KAVITA_A, "new": KAVITA_B},
            {"key": "integration.kavita.url", "effect": "reset_ebooks_connections",
             "label": "eBooks connections", "note": RESET_NOTE},
        ])
        self.assertConnected(self.sam)             # a preview changes nothing

    def test_apply_resets_every_connection_and_writes_only_the_setting(self):
        preview = self.importing({"integration.kavita.url": KAVITA_B}).json()
        r = self.importing({"integration.kavita.url": KAVITA_B}, dry=False, token=preview["diff_token"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["applied"], ["integration.kavita.url"])
        self.assertEqual(helpers.get(self.db, "integration.kavita.url"), KAVITA_B)
        self.assertReset(self.sam)
        self.assertReset(self.kim)
        after = self.proxied_as(self.sam) + self.proxied_as(self.sam, "api/image/series-cover")
        self.assertEqual(self.carrying_secrets(after), [])

    def test_the_diff_token_covers_the_reset(self):
        # The token is the hash of every entry, the reset included: a token
        # for the same diff without the reset is refused.
        from app.routers.admin_settings import _diff_token
        preview = self.importing({"integration.kavita.url": KAVITA_B}).json()
        self.assertEqual(preview["diff_token"], _diff_token(preview["changes"]))
        without = _diff_token([c for c in preview["changes"] if "effect" not in c])
        r = self.importing({"integration.kavita.url": KAVITA_B}, dry=False, token=without)
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual(helpers.get(self.db, "integration.kavita.url"), KAVITA_A)
        self.assertConnected(self.sam)

    def test_the_same_address_imported_keeps_the_connections(self):
        preview = self.importing({"integration.kavita.url": KAVITA_A + "/"}).json()
        self.assertEqual([c.get("effect") for c in preview["changes"]], [None])
        r = self.importing({"integration.kavita.url": KAVITA_A + "/"}, dry=False, token=preview["diff_token"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertConnected(self.sam)


class TokenBoundToItsAddress(KavitaAddressBase):
    def test_a_token_from_another_address_is_not_sent(self):
        # The session's token was recorded for KAVITA_A, but the setting now
        # says KAVITA_B (a handshake that finished just after the reset ran,
        # or a reset that failed): the token stays out of the request.
        helpers.put(self.db, "integration.kavita.url", KAVITA_B)
        sent = self.proxied_as(self.sam) + self.proxied_as(self.sam, "api/image/series-cover")
        self.assertEqual(self.carrying_secrets(sent), [])

    def test_a_token_with_no_recorded_address_is_not_sent(self):
        async def forget(r):
            await r.hdel(f"session:{self.sam}", "kavita_base")
        run(forget)
        self.assertEqual(self.carrying_secrets(self.proxied_as(self.sam)), [])

    def test_the_same_address_respelled_still_sends_it(self):
        helpers.put(self.db, "integration.kavita.url", "HTTP://192.168.1.20:5000/")
        self.assertTrue(self.carrying_secrets(self.proxied_as(self.sam)))
        cover = self.proxied_as(self.sam, "api/image/series-cover")
        self.assertIn(API_KEY, str(cover[0].url))


if __name__ == "__main__":
    unittest.main()
