"""
Ticket identity: what each sign-in carries, claiming legacy tickets, and the
migrations behind them.

Tickets and comments belong to a stable account identity (creator_identity,
author_identity), never to a username. A Plex account is its Plex account id,
whether it signed in to Plex directly or through Authentik's Plex source:
both look the account up on plex.tv (retrying once) and keep its id in the
session as plex_account_id, and a sign-in that cannot get the id is refused
with a retryable 503 rather than given a session that owns nothing. A local
account is its permanent users.uid under "local:" (users.id can be reused
after a delete). An Authentik identity without Plex is its OIDC subject
under "oidc:".

Tickets from before the columns existed have no identity. The owner claims
them at their next sign-in: by creator_email, only when the session's email
is verified; by the username only when the signer is a Plex account, the
ticket has no email, and no local account has (or had, at the upgrade) that
username. A local account never claims. A claimed row keeps its identity.
"""
import asyncio
import json
import logging
import unittest
from unittest import mock

try:
    import httpx
    from fastapi import FastAPI
    from passlib.hash import bcrypt
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from app.auth import SessionManager
    from app.database import get_db
    from app.limiter import limiter
    from app.models import Setting, Ticket, TicketComment, User
    from app.routers import auth as oidc_auth
    from app.routers import plex_auth, simple_auth
    from app.routers.tickets import account_identity, claim_legacy_tickets
    from app.seed import (
        LOCAL_USERNAMES_SNAPSHOT_KEY,
        migrate_local_usernames_snapshot,
        migrate_ticket_identity,
        migrate_user_uid,
    )
    from app.tests.test_plex_pin_claim import NONCE, PIN, FakePlexResponse, RouteHarness
    from app.tests.test_push import make_session_factory
    from app.tests.test_ticket_ownership import authentik, local, plex
    RealAsyncClient = httpx.AsyncClient
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False
    RouteHarness = unittest.TestCase

VERIFIED = {"email_verified": "true"}


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class AccountIdentity(unittest.TestCase):
    def test_plex_direct_is_the_plex_account_id(self):
        self.assertEqual(account_identity(plex("bob", "123456")), "plex:123456")

    def test_a_plex_session_from_before_plex_account_id_uses_its_user_id(self):
        # A Plex-direct session's user_id has always been the Plex account id.
        user = plex("bob", "123456")
        del user["plex_account_id"]
        self.assertEqual(account_identity(user), "plex:123456")

    def test_authentik_through_plex_is_the_same_plex_account_id(self):
        self.assertEqual(account_identity(authentik("bob", "123456", sub="abc")), "plex:123456")

    def test_authentik_without_plex_is_the_oidc_subject(self):
        user = authentik("dana", "", sub="abc")
        user["plex_token"] = ""
        self.assertEqual(account_identity(user), "oidc:abc")

    def test_authentik_through_plex_without_the_id_has_no_identity(self):
        # Sign-in refuses this now; a session like it still owns nothing.
        self.assertEqual(account_identity(authentik("bob", "", sub="abc")), "")

    def test_a_local_account_is_its_permanent_uid_namespaced(self):
        self.assertEqual(account_identity(local("bob", "0d1e")), "local:0d1e")
        self.assertEqual(account_identity({"username": "bob", "account_uid": "0d1e"}), "local:0d1e")

    def test_a_local_session_without_a_uid_has_no_identity(self):
        # Never the reusable users.id.
        self.assertEqual(account_identity({"username": "bob", "user_id": "7", "auth_method": "simple"}), "")

    def test_no_user_id_is_no_identity(self):
        for user in (local("bob", ""), plex("bob", ""), authentik("bob", "", sub=""), {}):
            self.assertEqual(account_identity(user), "", user)

    def test_the_request_never_supplies_it(self):
        # Only the session: a username that looks like an identity is just a name.
        self.assertEqual(account_identity(local("plex:123456", "7")), "local:7")


class _Claims(unittest.TestCase):
    def setUp(self):
        self.Session = make_session_factory()
        self.db = self.Session()
        self.addCleanup(self.db.close)

    def legacy(self, username, email=None, identity=None):
        t = Ticket(title="T", description="D", category="other", status="open", is_public=False,
                   creator_username=username, creator_name=username or "Unknown",
                   creator_email=email, creator_identity=identity)
        self.db.add(t)
        self.db.commit()
        return t.id

    def identity_of(self, ticket_id):
        self.db.expire_all()
        return self.db.query(Ticket).filter(Ticket.id == ticket_id).one().creator_identity

    def local_user(self, username):
        self.db.add(User(username=username, display_name=username, password_hash="x"))
        self.db.commit()

    def comment(self, ticket_id, username, is_admin=False, identity=None):
        c = TicketComment(ticket_id=ticket_id, author_username=username, author_name=username,
                          is_admin=is_admin, message="m", author_identity=identity)
        self.db.add(c)
        self.db.commit()
        return c.id

    def author_of(self, comment_id):
        self.db.expire_all()
        return self.db.query(TicketComment).filter(TicketComment.id == comment_id).one().author_identity


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ClaimByEmail(_Claims):
    def test_a_plex_account_claims_by_verified_email(self):
        tid = self.legacy("old-name", email="bob@example.com")
        user = plex("bob", "123456", email="Bob@Example.com ", **VERIFIED)
        self.assertEqual(claim_legacy_tickets(self.db, user), 1)
        self.assertEqual(self.identity_of(tid), "plex:123456")

    def test_both_sides_are_trimmed_and_casefolded(self):
        tid = self.legacy("x", email="  STRASSE@Example.COM ")
        claim_legacy_tickets(self.db, plex("y", "123456", email="straße@example.com", **VERIFIED))
        self.assertEqual(self.identity_of(tid), "plex:123456")

    def test_authentik_through_plex_claims_by_verified_email(self):
        tid = self.legacy("old-name", email="bob@example.com")
        claim_legacy_tickets(self.db, authentik("bob", "123456", email="bob@example.com", **VERIFIED))
        self.assertEqual(self.identity_of(tid), "plex:123456")

    def test_authentik_without_plex_claims_by_verified_email(self):
        tid = self.legacy("dana", email="dana@example.com")
        user = authentik("dana", "", sub="abc", email="dana@example.com", plex_token="", **VERIFIED)
        claim_legacy_tickets(self.db, user)
        self.assertEqual(self.identity_of(tid), "oidc:abc")

    def test_an_unverified_email_never_claims(self):
        # An Authentik identity can assert any email: Alice's private ticket
        # must not become someone else's because they typed her address.
        tid = self.legacy("alice", email="alice@example.com")
        for verified in ("false", "", None):
            for user in (authentik("mallory", "", sub="m", email="Alice@Example.com  ", plex_token=""),
                         plex("mallory", "666", email="alice@example.com")):
                user["email_verified"] = verified
                self.assertEqual(claim_legacy_tickets(self.db, user), 0, (verified, user))
        self.assertIsNone(self.identity_of(tid))

    def test_a_signer_without_an_identity_claims_nothing(self):
        tid = self.legacy("bob", email="bob@example.com")
        user = authentik("bob", "", email="bob@example.com", **VERIFIED)
        self.assertEqual(claim_legacy_tickets(self.db, user), 0)
        self.assertIsNone(self.identity_of(tid))

    def test_claiming_happens_once(self):
        tid = self.legacy("bob", email="bob@example.com")
        claim_legacy_tickets(self.db, plex("bob", "123456", email="bob@example.com", **VERIFIED))
        # Another account with the same email and name later: the row is taken.
        again = plex("bob", "999999", email="bob@example.com", **VERIFIED)
        self.assertEqual(claim_legacy_tickets(self.db, again), 0)
        self.assertEqual(self.identity_of(tid), "plex:123456")

    def test_tickets_that_already_have_an_identity_are_never_claimed(self):
        tid = self.legacy("bob", email="bob@example.com", identity="local:u7")
        claim_legacy_tickets(self.db, plex("bob", "123456", email="bob@example.com", **VERIFIED))
        self.assertEqual(self.identity_of(tid), "local:u7")

    def test_a_local_account_never_claims(self):
        by_email = self.legacy("bob", email="bob@example.com")
        by_name = self.legacy("bob")
        user = local("bob", "u7", email="bob@example.com", **VERIFIED)
        self.assertEqual(claim_legacy_tickets(self.db, user), 0)
        self.assertIsNone(self.identity_of(by_email))
        self.assertIsNone(self.identity_of(by_name))

    def test_an_empty_or_none_email_claims_nothing(self):
        none_email = self.legacy("x", email="none")
        self.assertEqual(claim_legacy_tickets(self.db, plex("", "123456", email="none", **VERIFIED)), 0)
        self.assertIsNone(self.identity_of(none_email))

    def test_the_creators_comments_come_with_a_ticket_claimed_by_email(self):
        tid = self.legacy("dana", email="dana@example.com")
        mine = self.comment(tid, "dana")
        admins = self.comment(tid, "admin", is_admin=True)
        user = authentik("dana", "", sub="abc", email="dana@example.com", plex_token="", **VERIFIED)
        claim_legacy_tickets(self.db, user)
        self.assertEqual(self.author_of(mine), "oidc:abc")
        self.assertIsNone(self.author_of(admins))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ClaimByUsername(_Claims):
    def test_a_plex_account_claims_by_username_when_the_ticket_has_no_email(self):
        tid = self.legacy("bob", email=None)
        blank = self.legacy("bob", email="")
        claim_legacy_tickets(self.db, plex("bob", "123456"))
        self.assertEqual(self.identity_of(tid), "plex:123456")
        self.assertEqual(self.identity_of(blank), "plex:123456")

    def test_authentik_through_plex_may_use_the_username_too(self):
        tid = self.legacy("bob")
        claim_legacy_tickets(self.db, authentik("bob", "123456"))
        self.assertEqual(self.identity_of(tid), "plex:123456")

    def test_the_username_never_claims_a_ticket_that_has_an_email(self):
        tid = self.legacy("bob", email="someone@example.com")
        claim_legacy_tickets(self.db, plex("bob", "123456", email="bob@example.com", **VERIFIED))
        self.assertIsNone(self.identity_of(tid))

    def test_only_a_plex_account_may_use_the_username(self):
        tid = self.legacy("dana")
        user = authentik("dana", "", sub="abc", email="dana@example.com", plex_token="", **VERIFIED)
        self.assertEqual(claim_legacy_tickets(self.db, user), 0)
        self.assertIsNone(self.identity_of(tid))

    def test_an_empty_username_claims_nothing(self):
        tid = self.legacy("")
        self.assertEqual(claim_legacy_tickets(self.db, plex("", "123456")), 0)
        self.assertIsNone(self.identity_of(tid))

    def test_not_when_a_local_account_has_that_username(self):
        # The legacy "bob" ticket may be the local bob's: leave it alone.
        tid = self.legacy("bob")
        c = self.comment(tid, "bob")
        self.local_user("Bob")   # case-insensitively the same name
        self.assertEqual(claim_legacy_tickets(self.db, plex("bob", "123456")), 0)
        self.assertIsNone(self.identity_of(tid))
        self.assertIsNone(self.author_of(c))

    def test_not_when_a_local_account_had_that_username_at_the_upgrade(self):
        # The local bob was renamed (or removed) after the upgrade: the
        # snapshot taken then still knows the name.
        self.local_user("bob")
        migrate_local_usernames_snapshot(self.db)
        self.db.query(User).filter(User.username == "bob").update({User.username: "robert"})
        self.db.commit()
        tid = self.legacy("bob")
        self.assertEqual(claim_legacy_tickets(self.db, plex("bob", "123456")), 0)
        self.assertIsNone(self.identity_of(tid))

    def test_email_claims_still_work_for_a_namesake_of_a_local_account(self):
        tid = self.legacy("bob", email="bob@example.com")
        self.local_user("bob")
        claim_legacy_tickets(self.db, plex("bob", "123456", email="bob@example.com", **VERIFIED))
        self.assertEqual(self.identity_of(tid), "plex:123456")

    def test_a_plex_account_claims_its_comments_by_username(self):
        other = self.legacy("carol", identity="plex:222222")
        c = self.comment(other, "bob")
        claim_legacy_tickets(self.db, plex("bob", "123456"))
        self.assertEqual(self.author_of(c), "plex:123456")

    def test_a_local_account_never_claims_comments(self):
        tid = self.legacy("bob", identity="local:u7")
        c = self.comment(tid, "bob")
        claim_legacy_tickets(self.db, local("bob", "u7"))
        self.assertIsNone(self.author_of(c))

    def test_a_claimed_comment_is_never_claimed_again(self):
        tid = self.legacy("bob")
        c = self.comment(tid, "bob", identity="plex:123456")
        claim_legacy_tickets(self.db, plex("bob", "999999"))
        self.assertEqual(self.author_of(c), "plex:123456")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class LocalUsernamesSnapshot(unittest.TestCase):
    def test_records_the_local_usernames_once(self):
        db = make_session_factory()()
        try:
            db.add_all([User(username=n, display_name=n, password_hash="x") for n in ("admin", "bob")])
            db.commit()
            migrate_local_usernames_snapshot(db)
            db.add(User(username="later", display_name="later", password_hash="x"))
            db.commit()
            migrate_local_usernames_snapshot(db)   # runs once: the marker row is the snapshot
            row = db.query(Setting).filter(Setting.key == LOCAL_USERNAMES_SNAPSHOT_KEY).one()
            self.assertEqual(sorted(json.loads(row.value)), ["admin", "bob"])
            self.assertTrue(LOCAL_USERNAMES_SNAPSHOT_KEY.startswith("migration."))
        finally:
            db.close()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ClaimedTicketsThroughTheApi(unittest.TestCase):
    def test_a_claimed_ticket_is_the_owners_and_not_a_local_namesakes(self):
        from app.tests.helpers import api_client, reset_overrides
        Session = make_session_factory()
        db = Session()
        db.add(Ticket(title="T", description="D", category="other", status="open", is_public=False,
                      creator_username="bob", creator_name="bob"))
        db.commit()
        bob = plex("bob", "123456")
        claim_legacy_tickets(db, bob)
        db.close()
        self.addCleanup(reset_overrides)
        with mock.patch("app.routers.setup.is_setup_completed", return_value=True):
            client = api_client(Session, bob)
            listed = client.get("/api/tickets").json()["tickets"]
            self.assertEqual([t["is_own"] for t in listed], [True])
            client = api_client(Session, local("bob", "u7"))
            self.assertEqual(client.get("/api/tickets").json()["tickets"], [])


# ---- what each sign-in stores ----

def _mapping(user_data):
    redis = mock.AsyncMock()
    manager = SessionManager()
    with mock.patch.object(manager, "get_redis", mock.AsyncMock(return_value=redis)):
        asyncio.run(manager.create_session("sid", user_data))
    return redis.hset.await_args.kwargs["mapping"]


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SessionFields(unittest.TestCase):
    def test_create_session_stores_the_identity_fields(self):
        mapping = _mapping({"user_id": "abc", "plex_account_id": 123456, "auth_method": "oidc",
                            "email_verified": True, "account_uid": "u-1"})
        self.assertEqual(mapping["plex_account_id"], "123456")
        self.assertEqual(mapping["email_verified"], "true")
        self.assertEqual(mapping["account_uid"], "u-1")

    def test_a_session_without_them_stores_them_empty_and_unverified(self):
        mapping = _mapping({"user_id": "7", "username": "bob"})
        self.assertEqual(mapping["plex_account_id"], "")
        self.assertEqual(mapping["account_uid"], "")
        self.assertEqual(mapping["email_verified"], "false")

    def test_only_a_true_value_is_verified(self):
        for value, expect in ((True, "true"), ("true", "true"), ("True", "true"), (False, "false"),
                              ("false", "false"), ("", "false"), (None, "false"), ("yes", "false")):
            self.assertEqual(_mapping({"email_verified": value})["email_verified"], expect, value)


def flaky_plex(authorized, user, failures):
    """plex.tv for the PIN flow: the PIN, and the user after `failures`
    failed lookups."""
    state = {"left": failures, "user_calls": 0}

    class Client:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, headers=None):
            if "/pins/" in url:
                return FakePlexResponse(200, {"authToken": "plex-token" if authorized() else None})
            state["user_calls"] += 1
            if state["left"] > 0:
                state["left"] -= 1
                raise httpx.ConnectError("plex.tv is down")
            return FakePlexResponse(200, user)

    return Client, state


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class PlexSignIn(RouteHarness):
    USER = {"id": 7, "username": "sam", "title": "Sam", "email": "sam@example.com", "thumb": "",
            "confirmed": True}

    def setUp(self):
        super().setUp()
        self.claim = mock.Mock(return_value=0)
        p = mock.patch.object(plex_auth, "claim_legacy_tickets", self.claim)
        p.start()
        self.addCleanup(p.stop)

    def plex_tv(self, failures=0, user=None):
        client, self.plex_state = flaky_plex(lambda: self.authorized, user or self.USER, failures)
        p = mock.patch.object(plex_auth.httpx, "AsyncClient", client)
        p.start()
        self.addCleanup(p.stop)

    def test_the_session_carries_the_plex_account_id_and_claims(self):
        self.plex_tv()
        r = self.post()[0]
        self.assertEqual(r.status_code, 200, r.text)
        session_data = self.create_session.await_args.args[1]
        self.assertEqual(session_data["plex_account_id"], "7")
        self.assertEqual(account_identity(session_data), "plex:7")
        self.assertEqual(self.claim.call_count, 1)
        self.assertEqual(account_identity(self.claim.call_args.args[1]), "plex:7")

    def test_a_confirmed_plex_email_is_verified(self):
        self.plex_tv()
        self.post()
        self.assertEqual(str(self.create_session.await_args.args[1]["email_verified"]).lower(), "true")

    def test_an_unconfirmed_plex_email_is_not(self):
        self.plex_tv(user={**self.USER, "confirmed": False})
        self.post()
        self.assertNotEqual(str(self.create_session.await_args.args[1]["email_verified"]).lower(), "true")

    def test_one_failed_lookup_is_retried(self):
        self.plex_tv(failures=1)
        r = self.post()[0]
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.plex_state["user_calls"], 2)
        self.assertEqual(self.create_session.await_args.args[1]["plex_account_id"], "7")

    def test_no_account_id_is_a_retryable_503_and_no_session(self):
        for failures, user in ((2, None), (0, {**self.USER, "id": None})):
            with self.subTest(failures=failures):
                self.redis.data[f"plex_pin:{PIN}"] = plex_auth._hash_pin_nonce(NONCE).encode()
                self.redis.data.pop(f"plex_pin_claim:{PIN}", None)
                self.plex_tv(failures=failures, user=user)
                r = self.post()[0]
                self.assertEqual(r.status_code, 503, r.text)
                self.assertIn("try again", r.json()["detail"].lower())
                self.create_session.assert_not_awaited()
                self.claim.assert_not_called()

    def test_a_failed_claim_does_not_block_sign_in(self):
        self.plex_tv()
        self.claim.side_effect = RuntimeError("db down")
        with self.assertLogs(plex_auth.logger, level=logging.WARNING):
            r = self.post()[0]
        self.assertEqual(r.status_code, 200, r.text)


class _FakeOIDC:
    redirect_uri = ""

    def __init__(self, userinfo):
        self.userinfo = userinfo

    async def exchange_code_for_token(self, code, code_verifier=""):
        return {"access_token": "at", "id_token": ""}

    async def get_userinfo(self, access_token):
        return dict(self.userinfo)


def _fake_plex_tv(payload, failures=0):
    state = {"left": failures, "calls": 0}

    class Resp:
        status_code = 200

        def json(self):
            return payload

    class Client:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, headers=None):
            state["calls"] += 1
            if state["left"] > 0:
                state["left"] -= 1
                raise httpx.ReadTimeout("slow")
            return Resp()

    return Client, state


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class AuthentikSignIn(unittest.TestCase):
    USERINFO = {"sub": "oidc-sub-1", "preferred_username": "bob", "name": "Bob",
                "email": "bob@example.com", "plex_token": "plex-token"}

    def setUp(self):
        self.app = FastAPI()
        self.app.state.limiter = limiter
        self.app.include_router(oidc_auth.router, prefix="/auth")
        self.db = object()

        def _db():
            yield self.db
        self.app.dependency_overrides[get_db] = _db
        self._limiter_was = limiter.enabled
        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", self._limiter_was)

        self.create_session = mock.AsyncMock()
        self.claim = mock.Mock(return_value=0)
        self.is_owner = mock.AsyncMock(return_value=False)
        self.oidc = _FakeOIDC(self.USERINFO)
        patches = [
            mock.patch.object(oidc_auth, "get_oidc_client", return_value=self.oidc),
            mock.patch.object(oidc_auth, "_authentik_auth_enabled", return_value=True),
            mock.patch.object(oidc_auth.session_manager, "consume_oidc_flow",
                              mock.AsyncMock(return_value={"state": "st", "code_verifier": "", "nonce": ""})),
            mock.patch.object(oidc_auth.session_manager, "create_session", self.create_session),
            mock.patch.object(oidc_auth, "_user_has_server_access", mock.AsyncMock(return_value=True)),
            mock.patch.object(oidc_auth, "_is_plex_server_owner", self.is_owner),
            mock.patch.object(oidc_auth.seerr, "authenticate_with_plex_token", mock.AsyncMock(return_value=None)),
            mock.patch.object(oidc_auth, "claim_legacy_tickets", self.claim),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.plex_tv()

    def plex_tv(self, payload=None, failures=0):
        client, self.plex_state = _fake_plex_tv(
            payload or {"id": 123456, "thumb": "", "email": "bob@example.com", "confirmed": True}, failures)
        p = mock.patch.object(oidc_auth.httpx, "AsyncClient", client)
        p.start()
        self.addCleanup(p.stop)

    def callback(self):
        async def run():
            transport = httpx.ASGITransport(app=self.app)
            async with RealAsyncClient(transport=transport, base_url="https://test",
                                         cookies={oidc_auth.OIDC_FLOW_COOKIE: "flow"}) as client:
                return await client.get("/auth/callback", params={"code": "c", "state": "st"})
        return asyncio.run(run())

    def session(self):
        return self.create_session.await_args.args[1]

    def test_the_session_carries_the_plex_account_id_and_claims(self):
        r = self.callback()
        self.assertEqual(r.status_code, 302, r.text)
        self.assertEqual(self.session()["plex_account_id"], "123456")
        self.assertEqual(account_identity(self.session()), "plex:123456")
        # The same identity a Plex-direct sign-in of the account gets.
        self.assertEqual(account_identity(self.session()), account_identity(plex("bob", "123456")))
        self.claim.assert_called_once()
        self.assertIs(self.claim.call_args.args[0], self.db)
        self.assertEqual(account_identity(self.claim.call_args.args[1]), "plex:123456")

    def test_one_failed_lookup_is_retried(self):
        self.plex_tv(failures=1)
        r = self.callback()
        self.assertEqual(r.status_code, 302, r.text)
        self.assertEqual(self.plex_state["calls"], 2)
        self.assertEqual(self.session()["plex_account_id"], "123456")

    def test_no_account_id_is_a_retryable_503_and_no_session(self):
        for payload, failures in ((None, 2), ({"id": None, "thumb": ""}, 0)):
            with self.subTest(failures=failures):
                self.plex_tv(payload=payload, failures=failures)
                r = self.callback()
                self.assertEqual(r.status_code, 503, r.text)
                self.assertIn("try again", r.json()["detail"].lower())
                self.create_session.assert_not_awaited()
                self.claim.assert_not_called()

    def test_without_a_plex_token_no_lookup_is_needed(self):
        self.oidc.userinfo = {**self.USERINFO, "plex_token": ""}
        r = self.callback()
        self.assertEqual(r.status_code, 302, r.text)
        self.assertEqual(self.plex_state["calls"], 0)
        self.assertEqual(account_identity(self.session()), "oidc:oidc-sub-1")

    def test_email_verified_by_the_oidc_claim(self):
        self.oidc.userinfo = {**self.USERINFO, "plex_token": "", "email_verified": True}
        self.callback()
        self.assertEqual(str(self.session()["email_verified"]).lower(), "true")

    def test_email_verified_by_plex_when_it_is_the_plex_accounts_confirmed_email(self):
        self.oidc.userinfo = {**self.USERINFO, "email": "Bob@Example.com", "email_verified": False}
        self.callback()
        self.assertEqual(str(self.session()["email_verified"]).lower(), "true")
        # The admin allowlist still sees only the OIDC claim, as before.
        self.assertIs(self.is_owner.await_args.kwargs["email_verified"], False)

    def test_not_verified_otherwise(self):
        cases = [
            ({"email_verified": False, "plex_token": ""}, None),
            ({"email_verified": "false"}, {"id": 123456, "email": "someone@else.example", "confirmed": True}),
            ({}, {"id": 123456, "email": "bob@example.com", "confirmed": False}),
        ]
        for extra, plex_user in cases:
            with self.subTest(extra=extra, plex_user=plex_user):
                self.create_session.reset_mock()
                self.oidc.userinfo = {**self.USERINFO, **extra}
                if plex_user:
                    self.plex_tv(payload=plex_user)
                self.callback()
                self.assertNotEqual(str(self.session().get("email_verified")).lower(), "true")

    def test_a_failed_claim_does_not_block_sign_in(self):
        self.claim.side_effect = RuntimeError("db down")
        with self.assertLogs(oidc_auth.logger, level=logging.WARNING):
            r = self.callback()
        self.assertEqual(r.status_code, 302, r.text)


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class LocalSignIn(unittest.TestCase):
    def setUp(self):
        self.Session = make_session_factory()
        db = self.Session()
        db.add(User(username="bob", display_name="Bob", password_hash=bcrypt.hash("pw"), email="bob@example.com"))
        db.commit()
        self.uid = db.query(User).one().uid
        db.close()

        self.app = FastAPI()
        self.app.state.limiter = limiter
        self.app.include_router(simple_auth.router, prefix="/auth")

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
        self.create_session = mock.AsyncMock()
        p = mock.patch.object(simple_auth.session_manager, "create_session", self.create_session)
        p.start()
        self.addCleanup(p.stop)

    def test_the_session_carries_the_permanent_uid(self):
        async def run():
            transport = httpx.ASGITransport(app=self.app)
            async with RealAsyncClient(transport=transport, base_url="https://test") as client:
                return await client.post("/auth/simple-login", json={"username": "bob", "password": "pw"})
        r = asyncio.run(run())
        self.assertEqual(r.status_code, 200, r.text)
        session_data = self.create_session.await_args.args[1]
        self.assertTrue(self.uid)
        self.assertEqual(session_data["account_uid"], self.uid)
        self.assertEqual(account_identity(session_data), f"local:{self.uid}")
        self.assertNotEqual(str(session_data.get("email_verified")).lower(), "true")


# ---- the migrations ----

def _old_schema_session():
    """A database whose tickets, comments and users predate the identity columns."""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE tickets (id INTEGER PRIMARY KEY, title VARCHAR(200) NOT NULL, "
            "creator_username VARCHAR(100) NOT NULL, creator_email VARCHAR(255))"
        ))
        conn.execute(text(
            "CREATE TABLE ticket_comments (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, "
            "author_username VARCHAR(100) NOT NULL)"
        ))
        conn.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(50) NOT NULL)"))
        conn.execute(text("INSERT INTO tickets (title, creator_username, creator_email) "
                          "VALUES ('old', 'bob', 'bob@example.com')"))
        conn.execute(text("INSERT INTO ticket_comments (ticket_id, author_username) VALUES (1, 'bob')"))
        conn.execute(text("INSERT INTO users (username) VALUES ('admin'), ('bob')"))
    return sessionmaker(bind=engine)()


def _columns(db, table):
    return {row[1] for row in db.execute(text(f"PRAGMA table_info({table})"))}


def _indexes(db, table):
    return {row[1]: row[2] for row in db.execute(text(f"PRAGMA index_list({table})"))}


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class IdentityMigration(unittest.TestCase):
    def test_adds_both_columns_once_and_keeps_the_rows(self):
        db = _old_schema_session()
        try:
            with self.assertLogs("app.seed", level=logging.INFO):
                migrate_ticket_identity(db)
            with self.assertNoLogs("app.seed", level=logging.INFO):
                migrate_ticket_identity(db)   # idempotent: nothing left to do
            self.assertIn("creator_identity", _columns(db, "tickets"))
            self.assertIn("author_identity", _columns(db, "ticket_comments"))
            self.assertIn("ix_tickets_creator_identity", _indexes(db, "tickets"))
            self.assertEqual(tuple(db.execute(text("SELECT title, creator_identity FROM tickets")).one()),
                             ("old", None))
            self.assertEqual(tuple(db.execute(text(
                "SELECT author_username, author_identity FROM ticket_comments")).one()), ("bob", None))
        finally:
            db.close()

    def test_no_op_on_a_fresh_schema(self):
        db = make_session_factory()()
        try:
            with self.assertNoLogs("app.seed", level=logging.INFO):
                migrate_ticket_identity(db)
            self.assertIn("creator_identity", _columns(db, "tickets"))
            self.assertIn("author_identity", _columns(db, "ticket_comments"))
            self.assertIn("ix_tickets_creator_identity", _indexes(db, "tickets"))
        finally:
            db.close()

    def test_a_worker_that_loses_the_race_carries_on(self):
        # Two workers start together: the second ALTER fails with "duplicate
        # column", which is not an error.
        db = _old_schema_session()
        try:
            real = db.execute
            calls = {"n": 0}

            def racing(stmt, *a, **kw):
                sql = str(stmt)
                if sql.startswith("ALTER TABLE tickets ADD COLUMN creator_identity") and calls["n"] == 0:
                    calls["n"] += 1
                    real(stmt, *a, **kw)   # the other worker got there first
                return real(stmt, *a, **kw)
            with mock.patch.object(db, "execute", side_effect=racing):
                migrate_ticket_identity(db)
            self.assertIn("creator_identity", _columns(db, "tickets"))
            self.assertIn("author_identity", _columns(db, "ticket_comments"))
        finally:
            db.close()

    def test_runs_at_startup_before_anything_reads_tickets(self):
        import inspect
        from app import database
        src = inspect.getsource(database.init_db)
        for name in ("migrate_ticket_identity(db)", "migrate_user_uid(db)",
                     "migrate_local_usernames_snapshot(db)"):
            self.assertIn(name, src)
            self.assertLess(src.index(name), src.index("seed_default_settings(db)"), name)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class UserUidMigration(unittest.TestCase):
    def uids(self, db):
        return dict(db.execute(text("SELECT id, uid FROM users ORDER BY id")).all())

    def test_adds_the_column_and_backfills_each_user_once(self):
        db = _old_schema_session()
        try:
            migrate_user_uid(db)
            first = self.uids(db)
            self.assertEqual(sorted(first), [1, 2])
            self.assertTrue(all(first.values()))
            self.assertEqual(len(set(first.values())), 2)
            self.assertEqual(_indexes(db, "users").get("ix_users_uid"), 1)   # unique
            migrate_user_uid(db)   # idempotent: nobody's uid changes
            self.assertEqual(self.uids(db), first)
        finally:
            db.close()

    def test_a_worker_that_loses_the_race_keeps_the_winners_uid(self):
        db = _old_schema_session()
        try:
            migrate_user_uid(db)
            db.execute(text("UPDATE users SET uid = NULL WHERE id = 1"))
            db.commit()
            real = db.execute
            done = {"n": 0}

            def racing(stmt, *a, **kw):
                if str(stmt).startswith("UPDATE users SET uid") and done["n"] == 0:
                    done["n"] += 1
                    real(text("UPDATE users SET uid = 'the-other-workers' WHERE id = 1"))
                return real(stmt, *a, **kw)
            with mock.patch.object(db, "execute", side_effect=racing):
                migrate_user_uid(db)
            self.assertEqual(self.uids(db)[1], "the-other-workers")
        finally:
            db.close()

    def test_no_op_on_a_fresh_schema_and_new_users_get_one(self):
        db = make_session_factory()()
        try:
            migrate_user_uid(db)
            self.assertIn("uid", _columns(db, "users"))
            db.add(User(username="a", display_name="a", password_hash="x"))
            db.commit()
            self.assertTrue(db.query(User).one().uid)
        finally:
            db.close()

    def test_a_reused_id_is_a_new_identity(self):
        # SQLite hands a deleted top row's id to the next user (no
        # AUTOINCREMENT on users), so the id alone cannot be the identity.
        db = make_session_factory()()
        try:
            old = User(username="a", display_name="a", password_hash="x")
            db.add(old)
            db.commit()
            old_id, old_uid = old.id, old.uid
            db.delete(old)
            db.commit()
            new = User(username="b", display_name="b", password_hash="x")
            db.add(new)
            db.commit()
            self.assertEqual(new.id, old_id)
            self.assertNotEqual(new.uid, old_uid)
            self.assertNotEqual(account_identity(local("b", new.uid)), account_identity(local("a", old_uid)))
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
