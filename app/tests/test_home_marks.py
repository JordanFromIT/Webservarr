"""
Home's first-paint marks (Home redesign, 2026-10-04): the server tells Home,
before anything is drawn, which shape the status strip takes
(status_feed.home_shape) and how many news posts it will show
(pages.home_marks), so each answer lands on the skeleton already drawn.

The shape rule is the client's (pages/home.js statusModel): a card while an
outage or an important note is open, no strip with no Uptime Kuma and nothing
in the feed's 30 days, else the slim line. The news count follows the rules
GET /api/news applies to Home's request.
"""

import unittest
from datetime import datetime, timedelta
from unittest import mock

from app.tests import helpers

try:
    import httpx  # noqa: F401 - only present with the app's dependencies
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

if HAVE_APP:
    from app import pages
    from app.integrations import config as integration_config
    from app.models import NewsPost, Setting, StatusUpdate
    from app.services import status_feed

NOW = datetime(2026, 10, 4, 12, 0, 0)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class HomeShape(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()

    def add(self, row):
        db = self.Session()
        try:
            db.add(row)
            db.commit()
        finally:
            db.close()

    def update(self, **fields):
        values = dict(title="t", message="t", update_type="note", severity="info", author_id="",
                      author_name="", active=True, source="admin", important=False, created_at=NOW)
        values.update(fields)
        self.add(StatusUpdate(**values))

    def kuma(self, url="http://kuma.test:3001"):
        self.add(Setting(key=integration_config.url_key("uptime_kuma"), value=url))

    def shape(self):
        db = self.Session()
        try:
            return status_feed.home_shape(db, NOW)
        finally:
            db.close()

    def test_no_kuma_and_nothing_posted_is_no_strip(self):
        self.assertEqual(self.shape(), "none")

    def test_no_kuma_with_a_note_in_the_window_is_a_line(self):
        self.update(active=False, created_at=NOW - timedelta(days=3), resolved_at=NOW - timedelta(days=3))
        self.assertEqual(self.shape(), "line")

    def test_no_kuma_with_only_old_updates_is_no_strip(self):
        self.update(active=False, created_at=NOW - timedelta(days=40), resolved_at=NOW - timedelta(days=40))
        self.assertEqual(self.shape(), "none")

    def test_kuma_set_up_is_a_line(self):
        self.kuma()
        self.assertEqual(self.shape(), "line")

    def test_an_open_outage_is_a_card(self):
        self.kuma()
        self.update(source="auto", update_type="incident", monitor_id=4, started_at=NOW - timedelta(minutes=5))
        self.assertEqual(self.shape(), "card")

    def test_an_open_important_note_is_a_card_and_a_plain_one_is_not(self):
        self.kuma()
        self.update(important=False)
        self.assertEqual(self.shape(), "line")
        self.update(important=True)
        self.assertEqual(self.shape(), "card")

    def test_a_resolved_outage_is_back_to_a_line(self):
        self.kuma()
        self.update(source="auto", update_type="resolved", monitor_id=4, active=False,
                    started_at=NOW - timedelta(hours=1), ended_at=NOW, resolved_at=NOW)
        self.assertEqual(self.shape(), "line")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class HomeMarks(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        p = mock.patch.object(pages, "SessionLocal", self.Session)
        p.start()
        self.addCleanup(p.stop)

    def post(self, days_old, pinned=False, published=True):
        db = self.Session()
        try:
            db.add(NewsPost(title="p", content="p", content_html="<p>p</p>", author_id="a", author_name="a",
                            created_at=datetime.utcnow() - timedelta(days=days_old), pinned=pinned,
                            published=published))
            db.commit()
        finally:
            db.close()

    def marks(self, news=None):
        return pages.home_marks({"news": news or {"homepage_count": 3, "homepage_max_age_days": 30}})

    def test_news_count_is_capped_at_two(self):
        for d in (1, 2, 3):
            self.post(d)
        self.assertEqual(self.marks()["home_news"], 2)

    def test_old_drafts_and_unpublished_do_not_count_but_a_pin_does(self):
        self.post(40)
        self.post(1, published=False)
        self.assertEqual(self.marks()["home_news"], 0)
        self.post(90, pinned=True)
        self.assertEqual(self.marks()["home_news"], 1)

    def test_no_age_limit_and_a_count_of_one(self):
        self.post(400)
        self.post(500)
        self.assertEqual(self.marks({"homepage_count": 1, "homepage_max_age_days": 0})["home_news"], 1)

    def test_the_status_shape_rides_along(self):
        self.assertEqual(self.marks()["home_status"], "none")

    def test_a_database_that_cannot_be_read_gives_the_common_shapes(self):
        with mock.patch.object(pages, "SessionLocal", side_effect=RuntimeError("down")):
            self.assertEqual(self.marks(), {"home_status": "line", "home_news": 2})

    def test_only_signed_in_home_reads_them(self):
        with mock.patch.object(pages, "home_marks", return_value={"home_status": "card", "home_news": 1}) as m, \
                mock.patch.object(pages, "load_context", return_value=({}, {})):
            out = pages.render_page("index", None, {"is_admin": "false", "username": "u"})
            self.assertIn(b' data-home-status="card"', out.body)
            m.assert_called_once()
            pages.render_page("calendar", None, {"is_admin": "false", "username": "u"})
            self.assertEqual(m.call_count, 1)


if __name__ == "__main__":
    unittest.main()
