"""
Push subscription routes and the admin test push.

* The status route tells the settings toggle whether the server really holds
  this browser's subscription (the browser keeping one is not enough).
* A push endpoint is one browser: when another account subscribes it, the
  previous account's row goes, so its notifications stop arriving there.
* Unsubscribing one browser leaves the user's other devices subscribed.
* The test push goes to the calling admin's own devices only.
"""
import unittest
from unittest import mock

try:
    from fastapi.testclient import TestClient

    from app.database import get_db
    from app.dependencies import get_current_user
    from app.limiter import limiter
    from app.main import app
    from app.models import PushSubscription
    from app.routers import admin as admin_router
    from app.tests.test_push import make_session_factory
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

ENDPOINT_A = "https://push.example.com/send/device-a"
ENDPOINT_B = "https://push.example.com/send/device-b"
KEYS = {"p256dh": "p", "auth": "a"}


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class PushRouteTests(unittest.TestCase):
    def setUp(self):
        self.Session = make_session_factory()
        self.user = {"email": "Alice@Example.com", "is_admin": "false"}

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
        patcher = mock.patch("app.routers.notifications.is_safe_push_endpoint", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()
        limiter.enabled = self._limiter_was

    def _rows(self):
        db = self.Session()
        try:
            return sorted((r.user_email, r.endpoint) for r in db.query(PushSubscription).all())
        finally:
            db.close()

    def _subscribe(self, endpoint):
        r = self.client.post("/api/notifications/push-subscribe",
                             json={"endpoint": endpoint, "keys": KEYS})
        self.assertEqual(r.status_code, 200, r.text)

    def _status(self, endpoint):
        r = self.client.get("/api/notifications/push-subscribe/status",
                            params={"endpoint": endpoint})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["subscribed"]

    def test_status_reflects_the_server_row(self):
        self.assertFalse(self._status(ENDPOINT_A))
        self._subscribe(ENDPOINT_A)
        self.assertTrue(self._status(ENDPOINT_A))
        self.assertFalse(self._status(ENDPOINT_B))

    def test_status_is_per_user(self):
        self._subscribe(ENDPOINT_A)
        self.user = {"email": "bob@example.com", "is_admin": "false"}
        self.assertFalse(self._status(ENDPOINT_A))

    def test_subscribing_writes_no_username_mapping(self):
        from app.models import Setting
        self.user = {"email": "Alice@Example.com", "username": "alice", "is_admin": "false"}
        self._subscribe(ENDPOINT_A)
        db = self.Session()
        try:
            self.assertEqual(db.query(Setting).filter(Setting.key.like("push.user.%")).count(), 0)
        finally:
            db.close()

    def test_resubscribing_is_idempotent(self):
        self._subscribe(ENDPOINT_A)
        self._subscribe(ENDPOINT_A)
        self.assertEqual(self._rows(), [("alice@example.com", ENDPOINT_A)])

    def test_new_account_on_a_browser_takes_its_endpoint_over(self):
        self._subscribe(ENDPOINT_A)
        self.user = {"email": "bob@example.com", "is_admin": "false"}
        self._subscribe(ENDPOINT_A)
        self.assertEqual(self._rows(), [("bob@example.com", ENDPOINT_A)])

    def test_unsubscribing_one_browser_keeps_the_others(self):
        self._subscribe(ENDPOINT_A)
        self._subscribe(ENDPOINT_B)
        r = self.client.delete("/api/notifications/push-subscribe",
                               params={"endpoint": ENDPOINT_A})
        self.assertEqual(r.json()["removed"], 1)
        self.assertEqual(self._rows(), [("alice@example.com", ENDPOINT_B)])

    def test_cannot_remove_another_users_subscription(self):
        self._subscribe(ENDPOINT_A)                      # alice's device
        self.user = {"email": "mallory@example.com", "is_admin": "false"}
        r = self.client.delete("/api/notifications/push-subscribe",
                               params={"endpoint": ENDPOINT_A})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["removed"], 0)
        self.assertEqual(self._rows(), [("alice@example.com", ENDPOINT_A)])

    def test_unsubscribing_without_endpoint_removes_all(self):
        self._subscribe(ENDPOINT_A)
        self._subscribe(ENDPOINT_B)
        r = self.client.delete("/api/notifications/push-subscribe")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["removed"], 2)
        self.assertEqual(self._rows(), [])

    def test_delete_by_id_still_works(self):
        from app.models import Notification
        db = self.Session()
        try:
            n = Notification(user_email="alice@example.com", category="news", title="t")
            db.add(n)
            db.commit()
            nid = n.id
        finally:
            db.close()
        r = self.client.delete(f"/api/notifications/{nid}")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.client.delete("/api/notifications/999999").status_code, 404)

    def test_test_push_needs_admin(self):
        r = self.client.post("/api/admin/notifications/test-push")
        self.assertEqual(r.status_code, 403)

    def test_test_push_targets_only_the_caller(self):
        self.user = {"email": "Admin@Example.com", "is_admin": "true"}
        sent = mock.AsyncMock(return_value={"attempted": 2, "succeeded": 1})
        with mock.patch.object(admin_router, "dispatch_push", sent):
            r = self.client.post("/api/admin/notifications/test-push")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"success": True, "attempted": 2, "succeeded": 1})
        self.assertEqual(sent.await_args.args[0], ["admin@example.com"])

    def test_test_push_reaches_the_admins_devices_and_nobody_elses(self):
        db = self.Session()
        try:
            db.add(PushSubscription(user_email="admin@example.com", endpoint=ENDPOINT_A, **KEYS))
            db.add(PushSubscription(user_email="friend@example.com", endpoint=ENDPOINT_B, **KEYS))
            db.commit()
        finally:
            db.close()
        self.user = {"email": "admin@example.com", "is_admin": "true"}

        tried = []

        async def fake_dispatch(emails, *a, **kw):
            db = self.Session()
            try:
                rows = db.query(PushSubscription).filter(PushSubscription.user_email.in_(emails)).all()
                tried.extend(r.endpoint for r in rows)
            finally:
                db.close()
            return {"attempted": len(rows), "succeeded": 0}

        with mock.patch.object(admin_router, "dispatch_push", fake_dispatch):
            r = self.client.post("/api/admin/notifications/test-push")
        self.assertEqual(r.json()["attempted"], 1)
        self.assertFalse(r.json()["success"])
        self.assertEqual(tried, [ENDPOINT_A])


if __name__ == "__main__":
    unittest.main()
