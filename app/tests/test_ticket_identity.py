"""
Ticket identity: what each sign-in carries, claiming legacy tickets, and the
migration that adds the identity columns.

Tickets and comments belong to a stable account identity (creator_identity,
author_identity), never to a username. A Plex account is its Plex account id,
whether it signed in to Plex directly (the session's user_id is that id) or
through Authentik's Plex source (the callback already looks the account up on
plex.tv, and now keeps its id in the session as plex_account_id). A local
account is its own user id under a "local:" prefix. An Authentik identity
without a Plex account is its OIDC subject under "oidc:".

Tickets from before the columns existed have no identity. The owner claims
them at their next sign-in: by the ticket's creator_email first; by the
username only when the signer is a Plex account and the ticket has no email.
A local account never claims. A claimed row keeps its identity for good.
"""
import asyncio
import logging
import unittest
from unittest import mock

try:
    import httpx
    from fastapi import FastAPI
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from app.auth import SessionManager
    from app.database import get_db
    from app.limiter import limiter
    from app.models import Ticket, TicketComment
    from app.routers import auth as oidc_auth
    from app.routers import plex_auth
    from app.routers.tickets import account_identity, claim_legacy_tickets
    from app.seed import migrate_ticket_identity
    from app.tests.test_plex_pin_claim import RouteHarness
    from app.tests.test_push import make_session_factory
    from app.tests.test_ticket_ownership import authentik, local, plex
    RealAsyncClient = httpx.AsyncClient
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False
    RouteHarness = unittest.TestCase


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

    def test_authentik_through_plex_whose_lookup_failed_has_no_identity(self):
        # Falling back to the OIDC subject would split one person's tickets
        # between two identities; owning nothing until the next sign-in is safer.
        self.assertEqual(account_identity(authentik("bob", "", sub="abc")), "")

    def test_a_local_account_is_its_user_id_namespaced(self):
        self.assertEqual(account_identity(local("bob", "7")), "local:7")
        self.assertEqual(account_identity({"username": "bob", "user_id": "7"}), "local:7")   # the default method

    def test_no_user_id_is_no_identity(self):
        for user in (local("bob", ""), plex("bob", ""), authentik("bob", "", sub=""), {}):
            self.assertEqual(account_identity(user), "", user)

    def test_the_request_never_supplies_it(self):
        # Only the session: a username that looks like an identity is just a name.
        self.assertEqual(account_identity(local("plex:123456", "7")), "local:7")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ClaimLegacyTickets(unittest.TestCase):
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

    def test_a_plex_account_claims_by_email(self):
        tid = self.legacy("old-name", email="bob@example.com")
        user = plex("bob", "123456", email="Bob@Example.com ")
        self.assertEqual(claim_legacy_tickets(self.db, user), 1)
        self.assertEqual(self.identity_of(tid), "plex:123456")

    def test_authentik_through_plex_claims_by_email(self):
        tid = self.legacy("old-name", email="bob@example.com")
        claim_legacy_tickets(self.db, authentik("bob", "123456", email="bob@example.com"))
        self.assertEqual(self.identity_of(tid), "plex:123456")

    def test_authentik_without_plex_claims_by_email(self):
        tid = self.legacy("dana", email="dana@example.com")
        user = authentik("dana", "", sub="abc", email="dana@example.com", plex_token="")
        claim_legacy_tickets(self.db, user)
        self.assertEqual(self.identity_of(tid), "oidc:abc")

    def test_a_plex_account_claims_by_username_when_the_ticket_has_no_email(self):
        tid = self.legacy("bob", email=None)
        blank = self.legacy("bob", email="")
        for user in (plex("bob", "123456", email="bob@example.com"),):
            claim_legacy_tickets(self.db, user)
        self.assertEqual(self.identity_of(tid), "plex:123456")
        self.assertEqual(self.identity_of(blank), "plex:123456")

    def test_authentik_through_plex_may_use_the_username_too(self):
        tid = self.legacy("bob")
        claim_legacy_tickets(self.db, authentik("bob", "123456"))
        self.assertEqual(self.identity_of(tid), "plex:123456")

    def test_the_username_never_claims_a_ticket_that_has_an_email(self):
        tid = self.legacy("bob", email="someone@example.com")
        claim_legacy_tickets(self.db, plex("bob", "123456", email="bob@example.com"))
        self.assertIsNone(self.identity_of(tid))

    def test_only_a_plex_account_may_use_the_username(self):
        tid = self.legacy("dana")
        user = authentik("dana", "", sub="abc", email="dana@example.com", plex_token="")
        self.assertEqual(claim_legacy_tickets(self.db, user), 0)
        self.assertIsNone(self.identity_of(tid))

    def test_a_local_account_never_claims(self):
        by_email = self.legacy("bob", email="bob@example.com")
        by_name = self.legacy("bob")
        self.assertEqual(claim_legacy_tickets(self.db, local("bob", "7", email="bob@example.com")), 0)
        self.assertIsNone(self.identity_of(by_email))
        self.assertIsNone(self.identity_of(by_name))

    def test_an_empty_username_or_email_claims_nothing(self):
        tid = self.legacy("")
        none_email = self.legacy("x", email="none")
        self.assertEqual(claim_legacy_tickets(self.db, plex("", "123456", email="none")), 0)
        self.assertIsNone(self.identity_of(tid))
        self.assertIsNone(self.identity_of(none_email))

    def test_a_signer_without_an_identity_claims_nothing(self):
        tid = self.legacy("bob", email="bob@example.com")
        self.assertEqual(claim_legacy_tickets(self.db, authentik("bob", "", email="bob@example.com")), 0)
        self.assertIsNone(self.identity_of(tid))

    def test_claiming_happens_once(self):
        tid = self.legacy("bob", email="bob@example.com")
        claim_legacy_tickets(self.db, plex("bob", "123456", email="bob@example.com"))
        # Another account with the same email and name later: the row is taken.
        self.assertEqual(claim_legacy_tickets(self.db, plex("bob", "999999", email="bob@example.com")), 0)
        self.assertEqual(self.identity_of(tid), "plex:123456")

    def test_tickets_that_already_have_an_identity_are_never_claimed(self):
        tid = self.legacy("bob", email="bob@example.com", identity="local:7")
        claim_legacy_tickets(self.db, plex("bob", "123456", email="bob@example.com"))
        self.assertEqual(self.identity_of(tid), "local:7")

    # ---- comments ----

    def comment(self, ticket_id, username, is_admin=False, identity=None):
        c = TicketComment(ticket_id=ticket_id, author_username=username, author_name=username,
                          is_admin=is_admin, message="m", author_identity=identity)
        self.db.add(c)
        self.db.commit()
        return c.id

    def author_of(self, comment_id):
        self.db.expire_all()
        return self.db.query(TicketComment).filter(TicketComment.id == comment_id).one().author_identity

    def test_the_creators_comments_come_with_a_ticket_claimed_by_email(self):
        tid = self.legacy("dana", email="dana@example.com")
        mine = self.comment(tid, "dana")
        admins = self.comment(tid, "admin", is_admin=True)
        user = authentik("dana", "", sub="abc", email="dana@example.com", plex_token="")
        claim_legacy_tickets(self.db, user)
        self.assertEqual(self.author_of(mine), "oidc:abc")
        self.assertIsNone(self.author_of(admins))

    def test_a_plex_account_claims_its_comments_by_username(self):
        other = self.legacy("carol", identity="plex:222222")
        c = self.comment(other, "bob")
        claim_legacy_tickets(self.db, plex("bob", "123456"))
        self.assertEqual(self.author_of(c), "plex:123456")

    def test_a_local_account_never_claims_comments(self):
        tid = self.legacy("bob", identity="local:7")
        c = self.comment(tid, "bob")
        claim_legacy_tickets(self.db, local("bob", "7"))
        self.assertIsNone(self.author_of(c))

    def test_a_claimed_comment_is_never_claimed_again(self):
        tid = self.legacy("bob")
        c = self.comment(tid, "bob", identity="plex:123456")
        claim_legacy_tickets(self.db, plex("bob", "999999"))
        self.assertEqual(self.author_of(c), "plex:123456")


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
            client = api_client(Session, local("bob", "7"))
            self.assertEqual(client.get("/api/tickets").json()["tickets"], [])


# ---- what each sign-in stores ----

@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SessionKeepsThePlexAccountId(unittest.TestCase):
    def test_create_session_stores_plex_account_id(self):
        redis = mock.AsyncMock()
        manager = SessionManager()
        with mock.patch.object(manager, "get_redis", mock.AsyncMock(return_value=redis)):
            asyncio.run(manager.create_session("sid", {"user_id": "abc", "plex_account_id": 123456,
                                                       "auth_method": "oidc"}))
        mapping = redis.hset.await_args.kwargs["mapping"]
        self.assertEqual(mapping["plex_account_id"], "123456")

    def test_a_session_without_one_stores_it_empty(self):
        redis = mock.AsyncMock()
        manager = SessionManager()
        with mock.patch.object(manager, "get_redis", mock.AsyncMock(return_value=redis)):
            asyncio.run(manager.create_session("sid", {"user_id": "7", "username": "bob"}))
        self.assertEqual(redis.hset.await_args.kwargs["mapping"]["plex_account_id"], "")


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class PlexSignInClaims(RouteHarness):
    def setUp(self):
        super().setUp()
        self.claim = mock.Mock(return_value=0)
        p = mock.patch.object(plex_auth, "claim_legacy_tickets", self.claim)
        p.start()
        self.addCleanup(p.stop)

    def test_the_session_carries_the_plex_account_id_and_claims(self):
        r = self.post()[0]
        self.assertEqual(r.status_code, 200, r.text)
        session_data = self.create_session.await_args.args[1]
        self.assertEqual(session_data["plex_account_id"], "7")
        self.assertEqual(account_identity(session_data), "plex:7")
        self.assertEqual(self.claim.call_count, 1)
        self.assertEqual(account_identity(self.claim.call_args.args[1]), "plex:7")

    def test_a_failed_claim_does_not_block_sign_in(self):
        self.claim.side_effect = RuntimeError("db down")
        with self.assertLogs(plex_auth.logger, level=logging.WARNING):
            r = self.post()[0]
        self.assertEqual(r.status_code, 200, r.text)


class _FakeOIDC:
    redirect_uri = ""

    async def exchange_code_for_token(self, code, code_verifier=""):
        return {"access_token": "at", "id_token": ""}

    async def get_userinfo(self, access_token):
        return {"sub": "oidc-sub-1", "preferred_username": "bob", "name": "Bob",
                "email": "bob@example.com", "plex_token": "plex-token"}


def _fake_plex_tv(payload):
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
            return Resp()

    return Client


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class AuthentikSignInClaims(unittest.TestCase):
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
        self.plex_user = {"id": 123456, "thumb": ""}
        patches = [
            mock.patch.object(oidc_auth, "get_oidc_client", return_value=_FakeOIDC()),
            mock.patch.object(oidc_auth, "_authentik_auth_enabled", return_value=True),
            mock.patch.object(oidc_auth.session_manager, "consume_oidc_flow",
                              mock.AsyncMock(return_value={"state": "st", "code_verifier": "", "nonce": ""})),
            mock.patch.object(oidc_auth.session_manager, "create_session", self.create_session),
            mock.patch.object(oidc_auth, "_user_has_server_access", mock.AsyncMock(return_value=True)),
            mock.patch.object(oidc_auth, "_is_plex_server_owner", mock.AsyncMock(return_value=False)),
            mock.patch.object(oidc_auth.seerr, "authenticate_with_plex_token", mock.AsyncMock(return_value=None)),
            mock.patch.object(oidc_auth.httpx, "AsyncClient", _fake_plex_tv(self.plex_user)),
            mock.patch.object(oidc_auth, "claim_legacy_tickets", self.claim),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def callback(self):
        async def run():
            transport = httpx.ASGITransport(app=self.app)
            async with RealAsyncClient(transport=transport, base_url="https://test",
                                         cookies={oidc_auth.OIDC_FLOW_COOKIE: "flow"}) as client:
                return await client.get("/auth/callback", params={"code": "c", "state": "st"})
        return asyncio.run(run())

    def test_the_session_carries_the_plex_account_id_and_claims(self):
        r = self.callback()
        self.assertEqual(r.status_code, 302, r.text)
        session_data = self.create_session.await_args.args[1]
        self.assertEqual(session_data["plex_account_id"], "123456")
        self.assertEqual(account_identity(session_data), "plex:123456")
        # The same identity a Plex-direct sign-in of the account gets.
        self.assertEqual(account_identity(session_data), account_identity(plex("bob", "123456")))
        self.claim.assert_called_once()
        self.assertIs(self.claim.call_args.args[0], self.db)
        self.assertEqual(account_identity(self.claim.call_args.args[1]), "plex:123456")

    def test_a_failed_claim_does_not_block_sign_in(self):
        self.claim.side_effect = RuntimeError("db down")
        with self.assertLogs(oidc_auth.logger, level=logging.WARNING):
            r = self.callback()
        self.assertEqual(r.status_code, 302, r.text)


# ---- the migration ----

def _old_schema_session():
    """A database whose tickets and comments predate the identity columns."""
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
        conn.execute(text("INSERT INTO tickets (title, creator_username, creator_email) "
                          "VALUES ('old', 'bob', 'bob@example.com')"))
        conn.execute(text("INSERT INTO ticket_comments (ticket_id, author_username) VALUES (1, 'bob')"))
    return sessionmaker(bind=engine)()


def _columns(db, table):
    return {row[1] for row in db.execute(text(f"PRAGMA table_info({table})"))}


def _indexes(db, table):
    return {row[1] for row in db.execute(text(f"PRAGMA index_list({table})"))}


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
        self.assertIn("migrate_ticket_identity(db)", src)
        self.assertLess(src.index("migrate_ticket_identity(db)"), src.index("seed_default_settings(db)"))


if __name__ == "__main__":
    unittest.main()
