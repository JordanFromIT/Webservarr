"""
Accounts without an email never share an identity.

Plex Home managed users (plex.tv sends "email": null) and OIDC identities
with no email claim have no email. create_session used to store that as the
string "None", so every such account was the same "none" user: the same
notifications, push subscriptions, preferences and ticket creator_email, and
one could receive another's ticket-reply pushes. Now a missing email is "",
identity_email() treats "" and "none" as no identity, such an account gets no
notifications or push at all, and a migration removes the shared rows.
"""
import asyncio
import unittest
from unittest import mock

try:
    from fastapi.testclient import TestClient

    from app.auth import SessionManager
    from app.database import get_db
    from app.dependencies import get_current_user
    from app.limiter import limiter
    from app.main import app
    from app.models import Notification, PushSubscription, Setting, Ticket
    from app.routers.notifications import _email_hash
    import requests

    from app.seed import migrate_no_email_identity, seed_vapid_keys
    from app.services import notification_poller as poller
    from app.services import push
    from app.tests.test_notification_poller import FakeRedis
    from app.tests.test_push import make_session_factory
    from app.utils import identity_email
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False


def run(coro):
    return asyncio.run(coro)


class _SessionRedis:
    def __init__(self):
        self.hashes = {}
        self.sets = {}

    async def hset(self, key, mapping):
        self.hashes[key] = dict(mapping)

    async def expire(self, key, ttl):
        return True

    async def sadd(self, key, member):
        self.sets.setdefault(key, set()).add(member)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class IdentityEmailTests(unittest.TestCase):
    def test_no_identity_values(self):
        for v in (None, "", "  ", "None", "none", " NONE "):
            with self.subTest(v=v):
                self.assertEqual(identity_email(v), "")

    def test_real_email_is_normalised(self):
        self.assertEqual(identity_email("  Bob@Example.COM "), "bob@example.com")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class CreateSessionTests(unittest.TestCase):
    def _create(self, user_data):
        sm = SessionManager.__new__(SessionManager)
        sm.max_age = 3600
        sm.absolute_max_age = 7200
        r = _SessionRedis()
        sm.get_redis = mock.AsyncMock(return_value=r)
        run(sm.create_session("sid", user_data))
        return r

    def test_explicit_null_email_is_stored_empty(self):
        r = self._create({"user_id": "7", "email": None, "username": "kid",
                          "auth_method": "plex", "avatar_url": None})
        stored = r.hashes["session:sid"]
        self.assertEqual(stored["email"], "")
        self.assertEqual(stored["avatar_url"], "")
        self.assertNotIn("None", stored.values())

    def test_null_user_id_is_not_indexed_as_none(self):
        r = self._create({"user_id": None, "sub": None, "email": None, "auth_method": "oidc"})
        self.assertEqual(r.hashes["session:sid"]["user_id"], "")
        self.assertEqual(r.sets, {})

    def test_present_values_are_kept(self):
        r = self._create({"sub": "abc", "email": "A@Example.com", "preferred_username": "a",
                          "is_admin": "true", "auth_method": "oidc"})
        stored = r.hashes["session:sid"]
        self.assertEqual((stored["user_id"], stored["email"], stored["username"], stored["is_admin"]),
                         ("abc", "A@Example.com", "a", "true"))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class NoSharedIdentityTests(unittest.TestCase):
    def setUp(self):
        self.Session = make_session_factory()
        db = self.Session()
        try:
            # Real VAPID keys, so push dispatch gets past its missing-keys
            # guard and actually reaches the recipient normalisation.
            seed_vapid_keys(db)
            # Legacy rows filed under the shared "none" identity.
            db.add(Notification(user_email="none", category="ticket", title="Admin replied: A's ticket"))
            db.add(PushSubscription(user_email="none", endpoint="https://push.example.com/a",
                                    p256dh="p", auth="a"))
            db.commit()
        finally:
            db.close()
        self.user = {"email": "None", "username": "kid-b", "is_admin": "false"}

        def _db():
            db = self.Session()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self._limiter_was = limiter.enabled
        limiter.enabled = False
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()
        limiter.enabled = self._limiter_was

    def test_no_email_account_sees_no_one_elses_notifications(self):
        for email in ("None", "", None):
            self.user = {"email": email, "username": "kid-b", "is_admin": "false"}
            with self.subTest(email=email):
                r = self.client.get("/api/notifications")
                self.assertEqual(r.json(), {"notifications": [], "total": 0})
                self.assertEqual(self.client.get("/api/notifications/unread-count").json(), {"count": 0})

    def test_no_email_account_cannot_touch_rows_filed_under_no_identity(self):
        db = self.Session()
        try:
            n = Notification(user_email="", category="news", title="orphan")
            db.add(n)
            db.commit()
            nid = n.id
        finally:
            db.close()
        self.user = {"email": "", "username": "kid-b", "is_admin": "false"}
        self.assertEqual(self.client.put(f"/api/notifications/{nid}/read").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/notifications/{nid}").status_code, 404)
        db = self.Session()
        try:
            row = db.query(Notification).filter(Notification.id == nid).one()
            self.assertFalse(row.read)
        finally:
            db.close()

    def test_broadcast_skips_no_identity_rows(self):
        db = self.Session()
        try:
            db.add(PushSubscription(user_email="bob@example.com", endpoint="https://push.example.com/bob",
                                    p256dh="p", auth="a"))
            db.add(Notification(user_email="", category="news", title="orphan"))
            db.commit()
        finally:
            db.close()
        self.user = {"email": "admin@example.com", "username": "admin", "is_admin": "true"}
        sent = mock.AsyncMock(return_value=0)
        with mock.patch("app.routers.admin.send_push_to_users", sent):
            r = self.client.post("/api/admin/notifications/send", json={"title": "Hi", "body": "All"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["sent_to"], 1)
        self.assertEqual(sent.await_args.args[0], ["bob@example.com"])
        db = self.Session()
        try:
            titles = sorted((n.user_email, n.title) for n in db.query(Notification).filter(Notification.title == "Hi"))
            self.assertEqual(titles, [("bob@example.com", "Hi")])
        finally:
            db.close()

    def test_push_subscribe_without_email_is_refused(self):
        r = self.client.post("/api/notifications/push-subscribe", json={
            "endpoint": "https://push.example.com/b", "keys": {"p256dh": "p", "auth": "a"}})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["detail"], "Push notifications need an account email.")

    def test_clear_all_does_not_touch_the_shared_rows(self):
        self.client.delete("/api/notifications")
        db = self.Session()
        try:
            self.assertEqual(db.query(Notification).count(), 1)
        finally:
            db.close()

    def test_poller_never_targets_a_no_email_account(self):
        r = FakeRedis()
        r.hashes["session:a"] = {"username": "kid-a", "email": "None"}
        r.hashes["session:b"] = {"username": "kid-b", "email": ""}
        db = self.Session()
        try:
            recipients = run(poller._collect_recipient_emails(r, db))
            self.assertEqual(recipients, set())
            created = run(poller._create_notification_once(r, db, "None", "service", "t", "b", "ref"))
            self.assertIsNone(created)
        finally:
            db.close()

    def _dispatch_to_no_identity(self):
        # _record_last_push is stubbed: the check below makes a send attempt on
        # purpose, and it must not become the dev instance's real last push.
        with mock.patch.object(push, "SessionLocal", self.Session), \
             mock.patch.object(push, "is_safe_push_endpoint", return_value=True), \
             mock.patch.object(push, "_record_last_push", mock.AsyncMock()), \
             mock.patch.object(requests.Session, "post", side_effect=AssertionError("pushed")):
            return run(push.dispatch_push(["None", "none", ""], "t", "b", "news"))

    def test_no_push_is_sent_to_the_shared_subscription(self):
        self.assertEqual(self._dispatch_to_no_identity(), {"attempted": 0, "succeeded": 0})

    def test_that_check_would_catch_the_old_normalisation(self):
        # With identity_email swapped for the old plain lower-casing, the
        # shared "none" subscription is found and a send is attempted: the
        # test above is not passing merely because dispatch bailed out early.
        with mock.patch.object(push, "identity_email", lambda e: (e or "").lower()):
            result = self._dispatch_to_no_identity()
        self.assertEqual(result["attempted"], 1)

    def test_ticket_from_a_no_email_account_stores_null(self):
        self.user = {"email": None, "username": "kid-b", "name": "Kid", "is_admin": "false"}
        r = self.client.post("/api/tickets", data={
            "title": "Help", "description": "Please", "category": "other"})
        self.assertEqual(r.status_code, 201, r.text)
        db = self.Session()
        try:
            self.assertIsNone(db.query(Ticket).one().creator_email)
        finally:
            db.close()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class MigrationTests(unittest.TestCase):
    def test_removes_shared_rows_and_is_idempotent(self):
        Session = make_session_factory()
        db = Session()
        try:
            none_hash = _email_hash("none")
            real_hash = _email_hash("bob@example.com")
            db.add_all([
                PushSubscription(user_email="none", endpoint="https://p/1", p256dh="p", auth="a"),
                PushSubscription(user_email="", endpoint="https://p/2", p256dh="p", auth="a"),
                PushSubscription(user_email="bob@example.com", endpoint="https://p/3", p256dh="p", auth="a"),
                Notification(user_email="None", category="news", title="x"),
                Notification(user_email="bob@example.com", category="news", title="y"),
                Ticket(title="t1", description="d", category="other", creator_username="kid",
                       creator_name="Kid", creator_email="none"),
                Ticket(title="t2", description="d", category="other", creator_username="bob",
                       creator_name="Bob", creator_email="bob@example.com"),
                Setting(key=f"notify.{none_hash}.news", value="false"),
                Setting(key=f"notify.{real_hash}.news", value="false"),
            ])
            db.commit()

            migrate_no_email_identity(db)
            migrate_no_email_identity(db)   # idempotent

            self.assertEqual([p.user_email for p in db.query(PushSubscription).all()], ["bob@example.com"])
            self.assertEqual([n.user_email for n in db.query(Notification).all()], ["bob@example.com"])
            self.assertEqual(sorted((t.title, t.creator_email) for t in db.query(Ticket).all()),
                             [("t1", None), ("t2", "bob@example.com")])
            self.assertEqual([s.key for s in db.query(Setting).all()], [f"notify.{real_hash}.news"])
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
