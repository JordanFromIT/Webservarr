"""
tickets.creator_email: the column, its migration, and stamping on create.

Ticket alerts are addressed to the creator's email because usernames from
different sign-in methods can collide. Existing databases gain the column
through a guarded, idempotent migration in seed.py, and the earlier
username->email settings rows (push.user.<hash>.email) are deleted.
"""
import unittest
from unittest import mock

try:
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from app.database import get_db
    from app.dependencies import get_current_user
    from app.limiter import limiter
    from app.main import app
    from app.models import Setting, Ticket
    from app.seed import migrate_drop_push_username_rows, migrate_ticket_creator_email
    from app.tests.test_push import make_session_factory
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False


def _old_schema_session():
    """A database whose tickets table predates creator_email."""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE tickets (id INTEGER PRIMARY KEY, title VARCHAR(200) NOT NULL, "
            "creator_username VARCHAR(100) NOT NULL)"
        ))
        conn.execute(text("INSERT INTO tickets (title, creator_username) VALUES ('old', 'bob')"))
    return sessionmaker(bind=engine)()


def _columns(db):
    return {row[1] for row in db.execute(text("PRAGMA table_info(tickets)"))}


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class MigrationTests(unittest.TestCase):
    def test_adds_the_column_once(self):
        db = _old_schema_session()
        try:
            migrate_ticket_creator_email(db)
            migrate_ticket_creator_email(db)   # idempotent
            self.assertIn("creator_email", _columns(db))
            row = db.execute(text("SELECT title, creator_email FROM tickets")).one()
            self.assertEqual(tuple(row), ("old", None))   # existing rows kept, null email
        finally:
            db.close()

    def test_no_op_on_a_fresh_schema(self):
        db = make_session_factory()()
        try:
            migrate_ticket_creator_email(db)
            self.assertIn("creator_email", _columns(db))
        finally:
            db.close()

    def test_drops_username_mapping_rows_only(self):
        db = make_session_factory()()
        try:
            db.add(Setting(key="push.user.0123456789abcdef.email", value="bob@example.com"))
            db.add(Setting(key="notify.0123456789abcdef.news", value="false"))
            db.commit()
            migrate_drop_push_username_rows(db)
            migrate_drop_push_username_rows(db)   # idempotent
            keys = [s.key for s in db.query(Setting).all() if not s.key.startswith("migration.")]
            self.assertEqual(keys, ["notify.0123456789abcdef.news"])
        finally:
            db.close()

    def test_drop_runs_once_behind_its_marker(self):
        db = make_session_factory()()
        try:
            migrate_drop_push_username_rows(db)
            self.assertEqual(db.query(Setting).filter(
                Setting.key == "migration.drop_push_username_rows_v1").count(), 1)
            db.add(Setting(key="push.user.fedcba9876543210.email", value="later@example.com"))
            db.commit()
            migrate_drop_push_username_rows(db)
            self.assertEqual(db.query(Setting).filter(Setting.key.like("push.user.%")).count(), 1)
        finally:
            db.close()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class StampingTests(unittest.TestCase):
    def setUp(self):
        self.Session = make_session_factory()

        def _db():
            db = self.Session()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[get_current_user] = lambda: {
            "username": "bob", "email": "Bob@Plex.Example", "name": "Bob", "is_admin": "false",
        }
        self._limiter_was = limiter.enabled
        limiter.enabled = False
        # Past the setup redirect without reading the instance's real database.
        setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        setup_patch.start()
        self.addCleanup(setup_patch.stop)
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()
        limiter.enabled = self._limiter_was

    def test_new_ticket_records_the_creator_email(self):
        r = self.client.post("/api/tickets", data={
            "title": "Buffering", "description": "It stutters", "category": "other",
        })
        self.assertEqual(r.status_code, 201, r.text)
        db = self.Session()
        try:
            self.assertEqual(db.query(Ticket).one().creator_email, "bob@plex.example")
        finally:
            db.close()
        self.assertNotIn("creator_email", r.json())


if __name__ == "__main__":
    unittest.main()
