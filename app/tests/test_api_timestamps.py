"""
News and wiki timestamps are sent as ISO 8601 UTC with a Z.

The database stores naive UTC (SQLite CURRENT_TIMESTAMP, datetime.utcnow()).
Sent without a zone, a browser reads "2026-09-01T12:00:00" as its own local
time, so everywhere west of UTC a post looked hours older than it was and the
wiki editor compared a fresh draft (stamped in UTC) against a page time that
was hours too late, and never offered to restore it.
"""
import re
import unittest
from datetime import datetime, timezone
from unittest import mock

try:
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False

UTC_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$")
WHEN = datetime(2026, 9, 1, 12, 30, 5)          # naive UTC, as stored


def instant(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Timestamps(unittest.TestCase):
    def setUp(self):
        from app.models import NewsPost, WikiPage

        self.Session = helpers.make_sessionmaker()
        db = self.Session()
        post = NewsPost(title="Live post", content="<p>x</p>", content_html="<p>x</p>", author_id="a",
                        author_name="Admin", published=True, created_at=WHEN, updated_at=WHEN, published_at=WHEN)
        db.add(post)
        db.add(WikiPage(title="First steps", slug="first-steps", content="x", content_html="<p>x</p>",
                        published=True, author_name="Admin", created_at=WHEN, updated_at=WHEN))
        db.commit()
        self.post_id = post.id
        db.close()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        self.client = helpers.api_client(self.Session, helpers.ADMIN)

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()

    def assertUtc(self, value, expected=WHEN):
        self.assertRegex(value, UTC_Z)
        self.assertEqual(instant(value), expected.replace(tzinfo=timezone.utc))

    def test_news_list_and_detail(self):
        for body in (self.client.get("/api/news/").json()[0], self.client.get(f"/api/news/{self.post_id}").json()):
            for key in ("created_at", "updated_at", "published_at"):
                with self.subTest(key=key):
                    self.assertUtc(body[key])

    def test_news_create_and_update(self):
        r = self.client.post("/api/news/", json={"title": "New", "content": "<p>n</p>", "published": True})
        self.assertEqual(r.status_code, 201, r.text)
        for key in ("created_at", "published_at"):
            self.assertRegex(r.json()[key], UTC_Z)
        r = self.client.put(f"/api/news/{self.post_id}", json={"title": "Live post, edited"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertUtc(r.json()["created_at"])

    def test_an_unset_news_time_stays_null(self):
        from app.models import NewsPost
        db = self.Session()
        db.add(NewsPost(title="Draft", content="d", content_html="<p>d</p>", author_id="a",
                        author_name="Admin", published=False, created_at=WHEN))
        db.commit()
        db.close()
        drafts = [p for p in self.client.get("/api/news/?published_only=false").json() if p["title"] == "Draft"]
        self.assertIsNone(drafts[0]["published_at"])

    def test_wiki_list_and_page(self):
        listed = self.client.get("/api/wiki/pages").json()
        page = listed[0] if isinstance(listed, list) else listed["pages"][0]
        self.assertUtc(page["updated_at"])
        body = self.client.get("/api/wiki/pages/first-steps").json()
        self.assertUtc(body["updated_at"])
        self.assertUtc(body["created_at"])

    def test_the_helper(self):
        from app.utils import utc_iso
        self.assertIsNone(utc_iso(None))
        self.assertEqual(utc_iso(WHEN), "2026-09-01T12:30:05.000Z")
        aware = datetime(2026, 9, 1, 14, 30, 5, tzinfo=timezone.utc).astimezone()
        self.assertEqual(utc_iso(aware), "2026-09-01T14:30:05.000Z")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TicketAndNotificationTimestamps(unittest.TestCase):
    """Tickets, their comments and the notification bell show "time ago":
    read as local time, everything west of UTC said "just now" for hours."""

    def setUp(self):
        from app.models import Notification, Ticket, TicketComment

        self.Session = helpers.make_sessionmaker()
        db = self.Session()
        ticket = Ticket(title="Help", description="d", category="other", creator_username="admin",
                        creator_name="Admin", created_at=WHEN, updated_at=WHEN)
        db.add(ticket)
        db.commit()
        self.ticket_id = ticket.id
        db.add(TicketComment(ticket_id=ticket.id, author_username="admin", author_name="Admin",
                             message="m", created_at=WHEN))
        db.add(Notification(user_email=helpers.ADMIN["email"], category="news", title="t", created_at=WHEN))
        db.commit()
        db.close()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        self.client = helpers.api_client(self.Session, helpers.ADMIN)

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()

    def assertUtc(self, value, expected=WHEN):
        self.assertRegex(value, UTC_Z)
        self.assertEqual(instant(value), expected.replace(tzinfo=timezone.utc))

    def test_ticket_list_detail_and_comments(self):
        listed = self.client.get("/api/tickets").json()
        tickets = listed["tickets"] if isinstance(listed, dict) else listed
        self.assertUtc(tickets[0]["created_at"])
        self.assertUtc(tickets[0]["updated_at"])
        detail = self.client.get(f"/api/tickets/{self.ticket_id}").json()
        self.assertUtc(detail["created_at"])
        self.assertUtc(detail["comments"][0]["created_at"])

    def test_a_new_comment_answers_in_utc(self):
        r = self.client.post(f"/api/tickets/{self.ticket_id}/comments", data={"message": "another"})
        self.assertIn(r.status_code, (200, 201), r.text)
        body = r.json()
        stamp = body.get("created_at") or (body.get("comment") or {}).get("created_at")
        self.assertRegex(stamp, UTC_Z)

    def test_notifications(self):
        body = self.client.get("/api/notifications").json()
        self.assertUtc(body["notifications"][0]["created_at"])


if __name__ == "__main__":
    unittest.main()
