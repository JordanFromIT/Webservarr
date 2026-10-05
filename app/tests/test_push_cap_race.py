"""
The per-account push device cap holds when two workers subscribe at once.

uvicorn runs two workers on one SQLite file. Two new devices for the same
account, subscribing at the same moment on different workers, must not both
read "20 rows", each prune to 19 and each insert: that ends at 21 and lets
the count creep. The cap is enforced under SQLite's write lock, in the same
transaction as the insert (R135).

Each "worker" here is its own engine and its own TestClient thread on one
temporary database file. A barrier sits just before the insert: if the two
requests could both get there, they would meet at it and both insert.
"""
import os
import tempfile
import threading
import unittest
from unittest import mock

try:
    from fastapi import Request
    from fastapi.testclient import TestClient
    from app.tests.helpers import SAME_ORIGIN
    from sqlalchemy.orm import Session as SASession, sessionmaker

    from app import database
    from app import models  # noqa: F401 - registers the tables on Base
    from app.database import get_db
    from app.dependencies import get_current_user
    from app.limiter import limiter
    from app.main import app
    from app.models import PushSubscription
    from app.routers import notifications
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False

EMAIL = "sam@example.com"
KEYS = {"p256dh": "B" + "x" * 86, "auth": "y" * 22}


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TwoWorkersAtTheCap(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        url = "sqlite:///" + os.path.join(self.dir.name, "pushrace.db")
        # Two engines on one file: two workers. The busy timeout is long
        # enough for one request to wait out the other's barrier.
        self.engines = [database.make_engine(url, connect_args={"check_same_thread": False, "timeout": 15})
                        for _ in range(2)]
        database.Base.metadata.create_all(bind=self.engines[0])
        self.makers = [sessionmaker(autocommit=False, autoflush=False, bind=e) for e in self.engines]
        db = self.makers[0]()
        for i in range(notifications.MAX_PUSH_DEVICES):
            db.add(PushSubscription(user_email=EMAIL, endpoint=f"https://push.example.com/send/old-{i:02d}", **KEYS))
        db.commit()
        db.close()

        # The request says which worker it is on; the dependency runs on the
        # TestClient's own thread, so a thread-local can't carry it.
        def _db(request: Request):
            db = self.makers[int(request.headers.get("x-test-worker", "0"))]()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[get_current_user] = lambda: {"email": EMAIL, "is_admin": "false"}
        self._limiter_was = limiter.enabled
        limiter.enabled = False
        for p in (mock.patch("app.routers.notifications.is_safe_push_endpoint", return_value=True),
                  mock.patch("app.routers.setup.is_setup_completed", return_value=True)):
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        app.dependency_overrides.clear()
        limiter.enabled = self._limiter_was
        for e in self.engines:
            e.dispose()
        self.dir.cleanup()

    def mine(self):
        db = self.makers[0]()
        try:
            return db.query(PushSubscription).filter(PushSubscription.user_email == EMAIL).count()
        finally:
            db.close()

    def test_two_new_devices_at_once_end_at_the_cap(self):
        barrier = threading.Barrier(2, timeout=2)
        met = []
        real_add = SASession.add

        def add(session, obj, *a, **kw):
            # The moment before the insert. Both requests here at once means
            # neither was holding the write lock while it decided what to prune.
            if isinstance(obj, PushSubscription):
                try:
                    barrier.wait()
                    met.append(True)
                except threading.BrokenBarrierError:
                    pass
            return real_add(session, obj, *a, **kw)

        results = {}

        def worker(n):
            client = TestClient(app, headers={**SAME_ORIGIN, "x-test-worker": str(n)})
            results[n] = client.post("/api/notifications/push-subscribe",
                                     json={"endpoint": f"https://push.example.com/send/new-{n}", "keys": KEYS})

        with mock.patch.object(SASession, "add", add):
            threads = [threading.Thread(target=worker, args=(n,)) for n in range(2)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(30)
        for n in range(2):
            self.assertEqual(results[n].status_code, 200, results[n].text)
        self.assertEqual(self.mine(), notifications.MAX_PUSH_DEVICES)
        self.assertEqual(met, [], "both requests decided what to prune before either held the lock")
        db = self.makers[0]()
        try:
            endpoints = {r.endpoint for r in db.query(PushSubscription).all()}
        finally:
            db.close()
        self.assertTrue({"https://push.example.com/send/new-0", "https://push.example.com/send/new-1"} <= endpoints)

    def test_an_account_already_over_the_cap_comes_back_to_it(self):
        # Rows a race left before this fix: the next new device brings the
        # account back to the cap, not merely one below where it was.
        db = self.makers[0]()
        for i in range(3):
            db.add(PushSubscription(user_email=EMAIL, endpoint=f"https://push.example.com/send/extra-{i}", **KEYS))
        db.commit()
        db.close()
        r = TestClient(app, headers=SAME_ORIGIN).post("/api/notifications/push-subscribe",
                                 json={"endpoint": "https://push.example.com/send/newest", "keys": KEYS})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.mine(), notifications.MAX_PUSH_DEVICES)


if __name__ == "__main__":
    unittest.main()
