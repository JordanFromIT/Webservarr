"""
The public request routes (spec section 6): the gate, the PIN and its browser binding in a namespace
of its own, identify's states, the one-use ticket, submit's rules under the submit lock, the token
that must never be kept, rate limits, input limits and same-origin. Plex is faked at the router's
own helpers, so nothing here reaches plex.tv.
"""
import asyncio
import json
import unittest
from pathlib import Path
from unittest import mock

try:
    import httpx  # noqa: F401
    from fastapi import FastAPI  # noqa: F401
    HAVE_APP = True
except ImportError:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

if HAVE_APP:
    import httpx
    from fastapi import FastAPI
    from fastapi.testclient import TestClient  # noqa: F401
    from app.auth import session_manager
    from app.config import settings
    from app.database import Base, get_db
    from app.integrations import plex_share
    from app.limiter import limiter
    from app.models import AccessRequest
    from app.routers import access_requests as access
    from app.routers import auth, plex_auth
    from app.services import access_requests as svc
    from app.tests import helpers
    from app.tests.test_integration_health import _private_limiter
    from app.tests.test_settings_gate import SettingsGateBase
    from app.tests.test_ticket_claim_signin import FakeRedis
    RealAsyncClient = httpx.AsyncClient

BASE = "/api/access-requests"
PIN = 424242
TOKEN = "PLEXTOKEN-SENTINEL-1f2e3d"
ADMIN_TOKEN = "ADMIN-TOKEN-NEVER-SHOWN"
ACCOUNT = {"id": 5551, "username": "newperson", "email": "new@example.com",
           "thumb": "https://plex.tv/users/abc/avatar?c=1"}


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class Membership(unittest.TestCase):
    def answer(self, configured, user):
        with mock.patch.object(auth, "_fetch_configured_server_identifiers", mock.AsyncMock(return_value=configured)), \
             mock.patch.object(auth, "_fetch_server_identifiers_for_token", user), \
             mock.patch.object(auth, "_plex_client_headers", return_value={}):
            return (asyncio.run(auth._server_membership("tok", None)),
                    asyncio.run(auth._user_has_server_access("tok", None)))

    def test_three_ways_and_the_old_gate_still_fails_closed(self):
        self.assertEqual(self.answer({"m"}, mock.AsyncMock(return_value={"m", "x"})), ("member", True))
        self.assertEqual(self.answer({"m"}, mock.AsyncMock(return_value={"x"})), ("not_member", False))
        self.assertEqual(self.answer(set(), mock.AsyncMock(return_value={"m"})), ("unknown", False))
        self.assertEqual(self.answer({"m"}, mock.AsyncMock(side_effect=RuntimeError("HTTP 500"))), ("unknown", False))
        self.assertEqual(asyncio.run(auth._server_membership("", None)), "not_member")

    def test_a_refused_token_is_neither_down_nor_not_a_member(self):
        refused = mock.AsyncMock(side_effect=auth.PlexTokenRejected("plex.tv resources returned HTTP 401"))
        self.assertEqual(self.answer({"m"}, refused), ("token_rejected", False))

    def test_only_a_401_is_a_refused_token(self):
        for code, raised in ((401, auth.PlexTokenRejected), (500, RuntimeError), (400, RuntimeError)):
            with self.subTest(code):
                async def send(client, request, **kw):
                    return httpx.Response(code, request=request)
                with mock.patch.object(httpx.AsyncClient, "send", send):
                    with self.assertRaises(raised) as caught:
                        asyncio.run(auth._fetch_server_identifiers_for_token("tok", {}))
                self.assertEqual(isinstance(caught.exception, auth.PlexTokenRejected), code == 401)


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class Harness(unittest.TestCase):
    """The access router and the Plex sign-in router alone, an in-memory
    database with the feature on, a fake Redis, and Plex faked at the
    router's helpers."""

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        db = self.Session()
        for key, value in (("access_requests.enabled", "true"), ("integration.plex.url", "http://192.168.1.2:32400"),
                           ("integration.plex.token", ADMIN_TOKEN)):
            helpers.put(db, key, value)
        db.close()
        self.redis = FakeRedis()
        self.token = TOKEN
        self.accounts = [dict(ACCOUNT)]
        self.membership = "not_member"
        self.share = None
        self.create_session = mock.AsyncMock()
        self.notify = mock.AsyncMock(return_value=0)

        self.app = FastAPI()
        self.app.state.limiter = limiter
        self.app.include_router(access.router, prefix=BASE)
        self.app.include_router(plex_auth.router, prefix="/auth")

        def _db():
            d = self.Session()
            try:
                yield d
            finally:
                d.close()
        self.app.dependency_overrides[get_db] = _db
        was = limiter.enabled
        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", was)

        async def pin_token(pin_id, client_id):
            await asyncio.sleep(0.02)
            return self.token

        async def plex_account(token, headers=None):
            self.assertEqual(token, TOKEN)
            return self.accounts.pop(0) if len(self.accounts) > 1 else dict(self.accounts[0])

        async def membership(token, db):
            return self.membership

        async def find_share(account_id):
            if isinstance(self.share, Exception):
                raise self.share
            return self.share

        for p in (mock.patch.object(session_manager, "get_redis", mock.AsyncMock(return_value=self.redis)),
                  mock.patch.object(session_manager, "create_session", self.create_session),
                  mock.patch.object(access, "_create_pin", mock.AsyncMock(return_value=(PIN, "CODE"))),
                  mock.patch.object(access, "_pin_token", side_effect=pin_token),
                  mock.patch.object(auth, "_fetch_plex_account", side_effect=plex_account),
                  mock.patch.object(auth, "_server_membership", side_effect=membership),
                  mock.patch.object(plex_share, "find_share", side_effect=find_share),
                  mock.patch.object(plex_auth, "_get_plex_client_id", return_value="client-id"),
                  mock.patch.object(svc, "notify_admins", self.notify)):
            p.start()
            self.addCleanup(p.stop)

    def drive(self, flow, origin=True):
        async def go():
            async with RealAsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="https://testserver",
                                       headers=helpers.SAME_ORIGIN if origin else None) as c:
                return await flow(c)
        return asyncio.run(go())

    async def pin(self, c):
        # The mock hands out the same PIN id every time; a finished identify
        # leaves its claim to expire, which would 409 the next one.
        self.redis.data.pop(f"access_pin_claim:{PIN}", None)
        c.cookies.clear()
        r = await c.post(BASE + "/pin")
        self.assertEqual(r.status_code, 200, r.text)
        return r.cookies.get(access.PIN_COOKIE)

    async def identify(self, c, nonce, pin_id=PIN, cookie=None):
        c.cookies.clear()
        cookies = {cookie or access.PIN_COOKIE: nonce} if nonce else None
        return await c.post(BASE + "/identify", json={"pin_id": pin_id}, cookies=cookies)

    async def ticket(self, c):
        r = await self.identify(c, await self.pin(c))
        self.assertEqual(r.json()["state"], "new", r.text)
        return r.cookies.get(access.TICKET_COOKIE)

    async def submit(self, c, ticket, name="New Person", note="A friend of Sam."):
        c.cookies.clear()
        return await c.post(BASE, json={"name": name, "note": note},
                            cookies={access.TICKET_COOKIE: ticket} if ticket else None)

    def rows(self):
        db = self.Session()
        try:
            return db.query(AccessRequest).all()
        finally:
            db.close()

    def add_row(self, account_id, status, **kw):
        db = self.Session()
        try:
            db.add(AccessRequest(plex_account_id=account_id, plex_username="u", name="N", note="n", status=status,
                                 created_at=svc.now_utc(), **kw))
            db.commit()
        finally:
            db.close()

    def set_open(self, value):
        db = self.Session()
        try:
            helpers.put(db, "access_requests.enabled", value)
        finally:
            db.close()


class Gate(Harness):
    def test_closed_refuses_every_route_before_anything_else(self):
        self.set_open("false")

        async def flow(c):
            return [await c.post(BASE + "/pin"), await self.identify(c, "x"), await self.submit(c, "t")]
        for r in self.drive(flow):
            self.assertEqual((r.status_code, r.json()["detail"]), (403, access.CLOSED))
        access._create_pin.assert_not_awaited()

    def test_plex_not_set_up_is_closed_too(self):
        db = self.Session()
        helpers.put(db, "integration.plex.token", "")
        db.close()
        r = self.drive(lambda c: c.post(BASE + "/pin"))
        self.assertEqual(r.status_code, 403)


class Pin(Harness):
    def test_a_pin_bound_to_this_browser_in_its_own_namespace(self):
        r = self.drive(lambda c: c.post(BASE + "/pin"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["pin_id"], PIN)
        self.assertIn("forwardUrl=https%3A%2F%2Ftestserver%2Fauth%2Fplex-callback-page%3Ffor%3Daccess", r.json()["auth_url"])
        cookie = [h for h in r.headers.get_list("set-cookie") if h.startswith(access.PIN_COOKIE + "=")][0].lower()
        for part in ("httponly", "samesite=lax", "path=/api/access-requests", "max-age=300"):
            self.assertIn(part, cookie)
        nonce = r.cookies.get(access.PIN_COOKIE)
        self.assertEqual(self.redis.data[f"access_pin:{PIN}"].decode(), plex_auth._hash_pin_nonce(nonce))
        self.assertNotIn(nonce.encode(), b"".join(self.redis.data.values()))
        self.assertNotIn(f"plex_pin:{PIN}", self.redis.data)


class Identify(Harness):
    def test_the_binding_gives_one_error_and_takes_no_claim(self):
        async def flow(c):
            await self.pin(c)
            return [await self.identify(c, None), await self.identify(c, "someone-else"),
                    await self.identify(c, "x", pin_id=999)]
        answers = {(r.status_code, r.json()["detail"]) for r in self.drive(flow)}
        self.assertEqual(answers, {(400, access.EXPIRED)})
        self.assertNotIn(f"access_pin_claim:{PIN}", self.redis.data)

    def test_two_at_once_one_wins(self):
        async def flow(c):
            nonce = await self.pin(c)
            c.cookies.clear()
            rs = await asyncio.gather(*[c.post(BASE + "/identify", json={"pin_id": PIN},
                                               cookies={access.PIN_COOKIE: nonce}) for _ in range(2)])
            return sorted(r.status_code for r in rs)
        self.assertEqual(self.drive(flow), [200, 409])

    def test_not_yet_authorized_releases_the_claim_and_keeps_the_pin(self):
        self.token = ""

        async def flow(c):
            return await self.identify(c, await self.pin(c))
        r = self.drive(flow)
        self.assertEqual((r.status_code, r.json()["detail"]), (400, access.NOT_YET))
        self.assertNotIn(f"access_pin_claim:{PIN}", self.redis.data)
        self.assertIn(f"access_pin:{PIN}", self.redis.data)

    def test_plex_down_or_unsure_is_503_never_not_a_member(self):
        for case in ("no account", "unknown"):
            with self.subTest(case):
                self.accounts = [{}] if case == "no account" else [dict(ACCOUNT)]
                self.membership = "unknown"

                async def flow(c):
                    return await self.identify(c, await self.pin(c))
                r = self.drive(flow)
                self.assertEqual((r.status_code, r.json()["detail"]), (503, access.PLEX_DOWN))
                self.assertNotIn(access.TICKET_COOKIE, r.headers.get("set-cookie", ""))
                # The PIN stays, so the card can ask again once Plex answers.
                self.assertIn(f"access_pin:{PIN}", self.redis.data)
                self.assertNotIn(f"access_pin_claim:{PIN}", self.redis.data)

    def test_plex_down_then_back_on_the_same_pin(self):
        self.membership = "unknown"

        async def flow(c):
            nonce = await self.pin(c)
            down = await self.identify(c, nonce)
            self.membership = "not_member"
            return down, await self.identify(c, nonce)
        down, back = self.drive(flow)
        self.assertEqual(down.status_code, 503)
        self.assertEqual((back.status_code, back.json()["state"]), (200, "new"))
        self.assertNotIn(f"access_pin:{PIN}", self.redis.data)

    def test_a_refused_token_starts_again_and_uses_up_the_pin(self):
        # plex.tv 401s the token the PIN gave: the account lookup comes back
        # empty and the membership check says so. Not Plex down (asking again
        # with the same PIN can't help) and never "not a member".
        for accounts in ([{}], [dict(ACCOUNT)]):
            with self.subTest(account=bool(accounts[0])):
                self.accounts = accounts
                self.membership = "token_rejected"

                async def flow(c):
                    return await self.identify(c, await self.pin(c))
                r = self.drive(flow)
                self.assertEqual((r.status_code, r.json()["detail"]), (400, access.EXPIRED))
                self.assertNotIn(access.TICKET_COOKIE, r.headers.get("set-cookie", ""))
                self.assertNotIn(f"access_pin:{PIN}", self.redis.data)
                self.assertNotIn(f"access_pin_claim:{PIN}", self.redis.data)

    def state(self):
        async def flow(c):
            return await self.identify(c, await self.pin(c))
        r = self.drive(flow)
        self.assertEqual(r.status_code, 200, r.text)
        return r

    def test_each_state(self):
        self.membership = "member"
        self.assertEqual(self.state().json(), {"state": "member", "username": "newperson",
                                               "avatar_url": "https://plex.tv/users/abc/avatar?c=1"})
        self.membership = "not_member"
        self.share = "pending"
        self.assertEqual(self.state().json()["state"], "invited")
        self.share = plex_share.PlexShareUnavailable("down")
        self.assertEqual(self.state().json()["state"], "new")
        self.share = None
        for status, extra in (("pending", {}), ("approved", {"decided_at": svc.now_utc()}),
                              ("blocked", {"decided_at": svc.now_utc()}),
                              ("denied", {"decided_at": svc.now_utc(), "cooldown_until": svc.now_utc() + svc.COOLDOWN})):
            with self.subTest(status):
                db = self.Session()
                db.query(AccessRequest).delete()
                db.commit()
                db.close()
                self.add_row("5551", status, **extra)
                body = self.state().json()
                self.assertEqual(body["state"], status)
                if status == "denied":
                    self.assertTrue(body["can_ask_after"].endswith("Z"))
                self.assertNotIn("new@example.com", json.dumps(body))

    def test_new_gets_a_one_use_ticket_and_never_an_email(self):
        r = self.state()
        body = r.json()
        self.assertEqual(body["state"], "new")
        self.assertNotIn("email", body)
        cookie = [h for h in r.headers.get_list("set-cookie") if h.startswith(access.TICKET_COOKIE + "=")][0].lower()
        for part in ("httponly", "samesite=strict", "path=/api/access-requests", "max-age=900"):
            self.assertIn(part, cookie)
        ticket = r.cookies.get(access.TICKET_COOKIE)
        stored = json.loads(self.redis.data[f"access_ticket:{plex_auth._hash_pin_nonce(ticket)}"])
        self.assertEqual(stored, {"plex_account_id": "5551", "plex_username": "newperson", "has_plex_username": True,
                                  "plex_email": "new@example.com",
                                  "plex_avatar_url": "https://plex.tv/users/abc/avatar?c=1"})
        self.assertNotIn(f"access_pin:{PIN}", self.redis.data)   # the PIN is used up

    def test_the_two_pin_namespaces_never_cross(self):
        self.redis.data[f"plex_pin:{PIN}"] = plex_auth._hash_pin_nonce("signin-nonce").encode()

        async def sign_in_pin_cannot_identify(c):
            return [await self.identify(c, "signin-nonce"),
                    await self.identify(c, "signin-nonce", cookie=plex_auth.PLEX_PIN_COOKIE)]
        for r in self.drive(sign_in_pin_cannot_identify):
            self.assertEqual(r.status_code, 400)
        del self.redis.data[f"plex_pin:{PIN}"]

        async def access_pin_cannot_sign_in(c):
            nonce = await self.pin(c)
            c.cookies.clear()
            return await c.post("/auth/plex-callback", json={"pin_id": PIN},
                                cookies={plex_auth.PLEX_PIN_COOKIE: nonce, access.PIN_COOKIE: nonce})
        with mock.patch.object(plex_auth, "_plex_auth_enabled", return_value=True):
            r = self.drive(access_pin_cannot_sign_in)
        self.assertEqual(r.status_code, 400)
        self.create_session.assert_not_awaited()


class Submit(Harness):
    def test_a_request_is_made_once_with_its_ticket(self):
        async def flow(c):
            t = await self.ticket(c)
            return t, await self.submit(c, t), await self.submit(c, t)
        ticket, first, again = self.drive(flow)
        self.assertEqual((first.status_code, first.json()), (200, {"state": "pending", "sent": True}))
        self.assertIn(f"{access.TICKET_COOKIE}=", first.headers.get("set-cookie", ""))   # cleared
        self.assertEqual((again.status_code, again.json()["detail"]), (400, access.TIMED_OUT))
        self.assertEqual([(r.plex_account_id, r.status, r.name) for r in self.rows()], [("5551", "pending", "New Person")])
        self.notify.assert_awaited_once()

    def test_a_display_name_is_kept_but_marked_as_no_username(self):
        # No Plex username: the card and Settings show the title, but the row
        # says it is not a username, so approving never invites by it.
        for account in (dict(ACCOUNT), dict(ACCOUNT, id=6662, username="", title="Sam's Display Name")):
            self.accounts = [account]

            async def flow(c):
                return await self.submit(c, await self.ticket(c))
            self.assertEqual(self.drive(flow).json(), {"state": "pending", "sent": True})
        self.assertEqual(sorted((r.plex_account_id, r.plex_username, r.has_plex_username) for r in self.rows()),
                         [("5551", "newperson", True), ("6662", "Sam's Display Name", False)])

    def test_a_ticket_from_before_the_flag_never_counts_as_a_username(self):
        db = self.Session()
        try:
            _, row = svc.place(db, {"plex_account_id": "5551", "plex_username": "old"}, "N", "n", svc.now_utc())
            self.assertFalse(row.has_plex_username)
        finally:
            db.close()

    def test_no_or_forged_or_expired_ticket(self):
        async def flow(c):
            t = await self.ticket(c)
            self.redis.data.clear()
            return [await self.submit(c, None), await self.submit(c, "forged-ticket"), await self.submit(c, t)]
        for r in self.drive(flow):
            self.assertEqual((r.status_code, r.json()["detail"]), (400, access.TIMED_OUT))
        self.assertEqual(self.rows(), [])

    def test_a_form_problem_keeps_the_ticket(self):
        async def flow(c):
            t = await self.ticket(c)
            return t, await self.submit(c, t, name="n" * 81), await self.submit(c, t, note=""), await self.submit(c, t)
        _, bad_name, bad_note, good = self.drive(flow)
        self.assertEqual((bad_name.status_code, bad_name.json()["detail"]), (422, svc.NAME_PROBLEM))
        self.assertEqual((bad_note.status_code, bad_note.json()["detail"]), (422, svc.NOTE_PROBLEM))
        self.assertEqual(good.json(), {"state": "pending", "sent": True})

    def test_an_open_request_made_meanwhile_answers_with_its_state(self):
        async def flow(c):
            t = await self.ticket(c)
            self.add_row("5551", "pending")      # another tab sent one after this identify
            return await self.submit(c, t)
        r = self.drive(flow)
        self.assertEqual((r.status_code, r.json()["state"], r.json()["sent"]), (200, "pending", False))
        self.assertEqual(len(self.rows()), 1)
        self.notify.assert_not_awaited()

    def test_switched_off_mid_flow(self):
        async def flow(c):
            t = await self.ticket(c)
            self.set_open("false")
            return t, await self.submit(c, t)
        ticket, r = self.drive(flow)
        self.assertEqual((r.status_code, r.json()["detail"]), (403, access.CLOSED))
        self.assertEqual(self.rows(), [])

    def test_place_runs_only_under_the_submit_lock(self):
        seen = []
        real = svc.place

        def place(*a, **kw):
            seen.append(access.SUBMIT_LOCK in self.redis.data)
            return real(*a, **kw)

        async def flow(c):
            return await self.submit(c, await self.ticket(c))
        with mock.patch.object(svc, "place", side_effect=place):
            self.assertEqual(self.drive(flow).status_code, 200)
        self.assertEqual(seen, [True])
        self.assertNotIn(access.SUBMIT_LOCK, self.redis.data)

    def test_a_held_lock_is_503_and_keeps_the_ticket(self):
        async def flow(c):
            t = await self.ticket(c)
            self.redis.data[access.SUBMIT_LOCK] = b"another-worker"
            return t, await self.submit(c, t)
        with mock.patch.object(access, "SUBMIT_LOCK_TRIES", 2), mock.patch.object(access, "SUBMIT_LOCK_WAIT", 0):
            ticket, r = self.drive(flow)
        self.assertEqual((r.status_code, r.json()["detail"]), (503, access.SUBMIT_BUSY))
        self.assertIn(f"access_ticket:{plex_auth._hash_pin_nonce(ticket)}", self.redis.data)
        self.assertEqual(self.redis.data[access.SUBMIT_LOCK], b"another-worker")

    def test_the_cap_holds_under_concurrent_submits(self):
        for i in range(svc.OPEN_CAP - 1):
            self.add_row(str(9000 + i), "pending")
        self.accounts = [{**ACCOUNT, "id": 7001}, {**ACCOUNT, "id": 7002}, {**ACCOUNT, "id": 7003}, {**ACCOUNT, "id": 7003}]

        async def flow(c):
            tickets = [await self.ticket(c) for _ in range(3)]
            c.cookies.clear()
            rs = await asyncio.gather(*[c.post(BASE, json={"name": "N", "note": "n"},
                                               cookies={access.TICKET_COOKIE: t}) for t in tickets])
            return sorted((r.status_code, r.json().get("detail")) for r in rs)
        codes = self.drive(flow)
        self.assertEqual(codes, [(200, None), (503, access.FULL), (503, access.FULL)])
        self.assertEqual(len([r for r in self.rows() if r.status == "pending"]), svc.OPEN_CAP)

    def test_one_open_request_per_account_under_concurrent_submits(self):
        async def flow(c):
            tickets = [await self.ticket(c) for _ in range(2)]
            c.cookies.clear()
            rs = await asyncio.gather(*[c.post(BASE, json={"name": "N", "note": "n"},
                                               cookies={access.TICKET_COOKIE: t}) for t in tickets])
            return sorted(r.json()["sent"] for r in rs)
        self.assertEqual(self.drive(flow), [False, True])
        self.assertEqual(len(self.rows()), 1)


class Limits(Harness):
    def test_input_limits(self):
        async def flow(c):
            t = await self.ticket(c)
            out = {
                "pin_id text": await c.post(BASE + "/identify", json={"pin_id": "abc"}),
                "pin_id zero": await c.post(BASE + "/identify", json={"pin_id": 0}),
                "pin_id huge": await c.post(BASE + "/identify", json={"pin_id": 2 ** 60}),
                "deep body": await c.post(BASE + "/identify", content="[" * 40 + "]" * 40,
                                          headers={"Content-Type": "application/json"}),
                "raw name too long": await self.submit(c, t, name="n" * 201),
                "raw note too long": await self.submit(c, t, note="n" * 4001),
                "lone surrogate": await c.post(BASE, content='{"name": "\\ud800", "note": "x"}',
                                               headers={"Content-Type": "application/json"},
                                               cookies={access.TICKET_COOKIE: t}),
                "control in name": await self.submit(c, t, name="Sam\x07"),
            }
            return t, out
        ticket, out = self.drive(flow)
        for what, r in out.items():
            with self.subTest(what):
                self.assertEqual(r.status_code, 422, r.text)
        self.assertIn(f"access_ticket:{plex_auth._hash_pin_nonce(ticket)}", self.redis.data)

    def test_same_origin_is_required(self):
        async def flow(c):
            return [await c.post(BASE + "/pin"), await c.post(BASE + "/identify", json={"pin_id": PIN}),
                    await c.post(BASE, json={"name": "N", "note": "n"})]
        for r in self.drive(flow, origin=False):
            self.assertEqual((r.status_code, r.json()["detail"]), (403, "Cross-origin request refused"))


class TokenNeverKept(Harness):
    def test_the_requesters_token_is_nowhere(self):
        responses = []

        async def flow(c):
            c.cookies.clear()
            pin = await c.post(BASE + "/pin")
            ident = await self.identify(c, pin.cookies.get(access.PIN_COOKIE))
            sent = await self.submit(c, ident.cookies.get(access.TICKET_COOKIE))
            responses.extend([pin, ident, sent])
            self.assertEqual([r.status_code for r in responses], [200, 200, 200])
            self.assertEqual(sent.json(), {"state": "pending", "sent": True})
        with self.assertLogs(level="DEBUG") as logs:
            self.drive(flow)
        stored = " ".join(k + " " + v.decode(errors="replace") for k, v in self.redis.data.items())
        self.assertNotIn(TOKEN, stored)
        db = self.Session()
        try:
            dump = "\n".join(repr(tuple(row)) for table in Base.metadata.sorted_tables
                             for row in db.execute(table.select()).fetchall())
        finally:
            db.close()
        self.assertNotIn(TOKEN, dump)
        self.assertNotIn(TOKEN, "\n".join(logs.output))
        self.assertEqual(len(responses), 3)
        for r in responses:
            self.assertNotIn(TOKEN, r.text + repr(r.headers))
        self.create_session.assert_not_awaited()


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class EveryCaller(SettingsGateBase):
    """Through the whole app and the real session lookup: the public routes
    answer a signed-out visitor, a member and an admin alike, sign nobody in,
    and are rate limited per client address."""

    ROUTES = [(BASE + "/pin", None), (BASE + "/identify", {"pin_id": 1}), (BASE, {"name": "Sam", "note": "Hi"})]

    def setUp(self):
        super().setUp()
        self.redis = FakeRedis()
        self.create_session = mock.AsyncMock()
        for p in (mock.patch.object(session_manager, "get_redis", mock.AsyncMock(return_value=self.redis)),
                  mock.patch.object(session_manager, "create_session", self.create_session)):
            p.start()
            self.addCleanup(p.stop)

    def open_up(self):
        helpers.put(self.db, "access_requests.enabled", "true")
        helpers.put(self.db, "integration.plex.url", "http://192.168.1.2:32400")

    def test_closed_for_everyone(self):
        for who, c in self.callers().items():
            for path, body in self.ROUTES:
                with self.subTest(who=who, path=path):
                    r = c.post(path, json=body)
                    self.assertEqual((r.status_code, r.json()["detail"]), (403, access.CLOSED))

    def test_open_answers_everyone_alike_and_signs_nobody_in(self):
        self.open_up()
        answers = {}
        for who, c in self.callers().items():
            got = []
            for path, body in self.ROUTES:
                r = c.post(path, json=body)
                got.append((r.status_code, r.json().get("detail")))
                self.assertNotIn(settings.session_cookie_name + "=", r.headers.get("set-cookie", ""))
            answers[who] = got
        # plex.tv is offline in this harness, so the PIN can't be made.
        want = [(503, access.PLEX_DOWN), (400, access.EXPIRED), (400, access.TIMED_OUT)]
        self.assertEqual(answers, {"signed out": want, "member": want, "admin": want})
        self.create_session.assert_not_awaited()

    def limited(self, path, body, allowed):
        restore = _private_limiter()
        self.addCleanup(restore)
        helpers.set_rate_limits(True)
        c = self.client()
        return [c.post(path, json=body).status_code for _ in range(allowed + 1)]

    def test_pin_five_a_minute(self):
        self.open_up()
        codes = self.limited(BASE + "/pin", None, 5)
        self.assertNotIn(429, codes[:5])
        self.assertEqual(codes[5], 429)

    def test_pin_also_twenty_an_hour(self):
        src = Path(access.__file__).read_text(encoding="utf-8")
        self.assertIn('@limiter.limit("5/minute;20/hour")\nasync def start_pin(', src)

    def test_identify_sixty_a_minute(self):
        self.open_up()
        codes = self.limited(BASE + "/identify", {"pin_id": 1}, 60)
        self.assertEqual(set(codes[:60]), {400})
        self.assertEqual(codes[60], 429)

    def test_submit_five_an_hour(self):
        self.open_up()
        codes = self.limited(BASE, {"name": "Sam", "note": "Hi"}, 5)
        self.assertEqual(set(codes[:5]), {400})
        self.assertEqual(codes[5], 429)


if __name__ == "__main__":
    unittest.main()
