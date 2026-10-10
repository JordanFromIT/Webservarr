"""
Where the admin's request notices go (spec section 8, amended 2026-10-10): never by comparing
emails. Each admin sign-in records the Plex account id that made it admin and the email its bell is
filed under; a new request notifies the emails recorded for the account that owns the admin token.
So an admin whose Authentik email differs from the plex.tv email is still reached, and someone who
is admin only through the email allowlist is not.
"""
import asyncio
import re
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
    from app.auth import session_manager
    from app.models import AccessRequest, AdminContact, Notification
    from app.routers import auth as oidc_auth
    from app.routers import plex_auth
    from app.routers.notifications import NOTIFICATION_CATEGORIES, PreferencesUpdate, _email_hash
    from app.services import access_requests as svc
    from app.services import admin_contacts
    from app.tests import helpers
    from app.tests.test_plex_pin_claim import NONCE, PIN
    from app.tests.test_ticket_claim_signin import FakeRedis, _SignInHarness

STATIC = Path(__file__).resolve().parents[1] / "static"
OWNER = {"is_admin": "true", "plex_account_id": "7"}


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class Remember(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.addCleanup(self.db.close)

    def rows(self):
        self.db.expire_all()
        return sorted((c.plex_account_id, c.notify_email) for c in self.db.query(AdminContact).all())

    def test_an_admin_session_is_recorded_once_per_email(self):
        self.assertTrue(admin_contacts.remember(self.db, {**OWNER, "email": " Jordan@Authentik.Example "}))
        first = self.db.query(AdminContact).one().seen_at
        self.assertTrue(admin_contacts.remember(self.db, {**OWNER, "email": "jordan@authentik.example"}))
        self.assertTrue(admin_contacts.remember(self.db, {**OWNER, "email": "owner@plex.example"}))
        self.assertEqual(self.rows(), [("7", "jordan@authentik.example"), ("7", "owner@plex.example")])
        again = self.db.query(AdminContact).filter_by(notify_email="jordan@authentik.example").one().seen_at
        self.assertGreaterEqual(again, first)

    def test_nothing_is_recorded_without_admin_an_email_or_a_plex_id(self):
        for session in ({"is_admin": "false", "plex_account_id": "7", "email": "a@example.com"},
                        {**OWNER, "email": ""}, {**OWNER, "email": "None"},
                        {"is_admin": "true", "plex_account_id": "", "email": "a@example.com"},
                        {"is_admin": "true", "email": "a@example.com"}):
            with self.subTest(session=session):
                self.assertFalse(admin_contacts.remember(self.db, session))
        self.assertEqual(self.rows(), [])

    def test_emails_for_the_owner_only(self):
        admin_contacts.remember(self.db, {**OWNER, "email": "b@example.com"})
        admin_contacts.remember(self.db, {**OWNER, "email": "a@example.com"})
        admin_contacts.remember(self.db, {"is_admin": "true", "plex_account_id": "99", "email": "c@example.com"})
        self.assertEqual(admin_contacts.emails_for(self.db, "7"), ["a@example.com", "b@example.com"])
        self.assertEqual(admin_contacts.emails_for(self.db, 7), ["a@example.com", "b@example.com"])
        self.assertEqual(admin_contacts.emails_for(self.db, ""), [])
        self.assertEqual(admin_contacts.emails_for(self.db, "8"), [])


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class SignInRecordsTheAdmin(_SignInHarness):
    """Both real sign-in callbacks record the admin's contact."""

    def owner_is(self, value):
        for p in (mock.patch.object(oidc_auth, "_is_plex_server_owner", mock.AsyncMock(return_value=value)),
                  mock.patch.object(plex_auth, "_is_plex_server_owner", mock.AsyncMock(return_value=value))):
            p.start()
            self.addCleanup(p.stop)

    def contacts(self):
        db = self.Session()
        try:
            return sorted((c.plex_account_id, c.notify_email) for c in db.query(AdminContact).all())
        finally:
            db.close()

    def plex_direct(self):
        self.redis.data[f"plex_pin:{PIN}"] = plex_auth._hash_pin_nonce(NONCE).encode()
        self.plex_tv({"id": 7, "username": "owner", "title": "Owner", "email": "Owner@Plex.example", "thumb": ""})

        async def flow(client):
            r = await client.post("/auth/plex-callback", json={"pin_id": PIN},
                                  cookies={plex_auth.PLEX_PIN_COOKIE: NONCE})
            self.assertEqual(r.status_code, 200, r.text)
        self.drive(flow)

    def authentik(self):
        userinfo = {"sub": "oidc-sub-1", "preferred_username": "jordan", "name": "Jordan",
                    "email": "Jordan@Authentik.Example", "plex_token": "plex-token"}

        class OIDC:
            redirect_uri = ""

            async def exchange_code_for_token(self, code, code_verifier=""):
                return {"access_token": "at", "id_token": ""}

            async def get_userinfo(self, access_token):
                return dict(userinfo)

        for p in (mock.patch.object(oidc_auth, "get_oidc_client", return_value=OIDC()),
                  mock.patch.object(session_manager, "consume_oidc_flow",
                                    mock.AsyncMock(return_value={"state": "st", "code_verifier": "", "nonce": ""})),
                  mock.patch.object(oidc_auth.seerr, "authenticate_with_plex_token", mock.AsyncMock(return_value=None))):
            p.start()
            self.addCleanup(p.stop)
        self.plex_tv({"id": 7, "username": "owner", "email": "owner@plex.example", "thumb": "", "confirmed": True})

        async def flow(client):
            r = await client.get("/auth/callback", params={"code": "c", "state": "st"},
                                 cookies={oidc_auth.OIDC_FLOW_COOKIE: "flow"})
            self.assertEqual(r.status_code, 302, r.text)
        self.drive(flow)

    def test_plex_direct_records_the_plex_email(self):
        self.owner_is(True)
        self.plex_direct()
        self.assertEqual(self.contacts(), [("7", "owner@plex.example")])

    def test_authentik_records_the_authentik_email_under_the_plex_id(self):
        self.owner_is(True)
        self.authentik()
        self.assertEqual(self.contacts(), [("7", "jordan@authentik.example")])

    def test_a_member_records_nothing(self):
        self.owner_is(False)
        self.plex_direct()
        self.assertEqual(self.contacts(), [])

    def test_a_failing_record_never_refuses_the_sign_in(self):
        self.owner_is(True)
        with mock.patch.object(admin_contacts, "remember", side_effect=RuntimeError("db gone")):
            self.plex_direct()      # asserts the 200 itself
            self.authentik()        # asserts the 302 itself


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class Notify(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.addCleanup(self.db.close)
        self.redis = FakeRedis()
        self.push = mock.AsyncMock(return_value={"attempted": 1, "succeeded": 1})
        self.owner = mock.AsyncMock(return_value={"id": 7, "email": "owner@plex.example"})
        for p in (mock.patch("app.services.push.dispatch_push", self.push),
                  mock.patch("app.routers.auth._fetch_owner_account", self.owner)):
            p.start()
            self.addCleanup(p.stop)
        self.row = AccessRequest(plex_account_id="5551", plex_username="newperson", name="New",
                                 note="SECRET-NOTE text", status="pending", created_at=svc.now_utc())
        self.db.add(self.row)
        self.db.commit()
        admin_contacts.remember(self.db, {**OWNER, "email": "jordan@authentik.example"})
        admin_contacts.remember(self.db, {**OWNER, "email": "owner@plex.example"})
        admin_contacts.remember(self.db, {"is_admin": "true", "plex_account_id": "99", "email": "allowlisted@example.com"})
        helpers.put(self.db, "system.admin_email", "allowlisted@example.com")

    def notify(self):
        return asyncio.run(svc.notify_admins(self.redis, self.db, self.row))

    def bells(self):
        self.db.expire_all()
        return sorted((n.user_email, n.category, n.title, n.body, n.reference_id)
                      for n in self.db.query(Notification).all())

    def test_the_owners_contacts_get_a_bell_and_one_push(self):
        self.assertEqual(self.notify(), 2)
        ref = f"access:{self.row.id}"
        self.assertEqual(self.bells(), [
            ("jordan@authentik.example", "access", "Access request", "newperson asked for access", ref),
            ("owner@plex.example", "access", "Access request", "newperson asked for access", ref)])
        self.push.assert_awaited_once()
        emails, title, body, category, url = self.push.await_args.args
        self.assertEqual((sorted(emails), title, body, category, url),
                         (["jordan@authentik.example", "owner@plex.example"], "Access request",
                          "newperson asked for access", "access", "/settings#access-requests"))

    def test_the_note_never_reaches_a_bell_or_a_push(self):
        self.notify()
        self.assertNotIn("SECRET-NOTE", repr(self.bells()))
        self.assertNotIn("SECRET-NOTE", repr(self.push.await_args))

    def test_an_allowlist_only_admin_gets_nothing(self):
        self.notify()
        self.assertNotIn("allowlisted@example.com", [b[0] for b in self.bells()])
        self.assertNotIn("allowlisted@example.com", self.push.await_args.args[0])

    def test_once_per_request(self):
        self.notify()
        self.assertEqual(self.notify(), 0)
        self.assertEqual(len(self.bells()), 2)
        self.push.assert_awaited_once()

    def test_a_preference_turned_off_is_kept(self):
        helpers.put(self.db, f"notify.{_email_hash('jordan@authentik.example')}.access", "false")
        self.assertEqual(self.notify(), 1)
        self.assertEqual(self.push.await_args.args[0], ["owner@plex.example"])

    def test_no_owner_means_no_notice_and_no_error(self):
        self.owner.return_value = None
        with self.assertLogs("app.services.access_requests", level="WARNING") as logs:
            self.assertEqual(self.notify(), 0)
        self.assertIn(f"Access request {self.row.id}", "\n".join(logs.output))
        self.assertEqual(self.bells(), [])
        self.push.assert_not_awaited()

    def test_a_push_failure_keeps_the_bells(self):
        self.push.side_effect = RuntimeError("push service down")
        self.assertEqual(self.notify(), 2)
        self.assertEqual(len(self.bells()), 2)


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class Category(unittest.TestCase):
    def test_the_server_knows_the_access_category(self):
        self.assertEqual(NOTIFICATION_CATEGORIES[-1], "access")
        self.assertIn("access", PreferencesUpdate.model_fields)

    def test_the_bell_draws_links_and_names_it_and_only_admins_see_its_toggle(self):
        js = (STATIC / "js" / "notifications.js").read_text(encoding="utf-8")
        self.assertRegex(js, r"access: 'person_add'")
        self.assertRegex(js, r"access: '/settings#access-requests'")
        self.assertRegex(js, r"access: 'Access requests'")
        self.assertIn("if (cat === 'access' && !isAdmin) return;", js)
        icons = (STATIC / "fonts" / "material-symbols-outlined.icons.txt").read_text(encoding="utf-8").split()
        self.assertIn("person_add", icons)


if __name__ == "__main__":
    unittest.main()
