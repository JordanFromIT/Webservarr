"""
Home's pinned problems, written into the page by the server
(app/home_event_log.py).

An open outage or an open important note is a row above the event log's
wheel, not a line on it. The server writes the rows into Home's HTML, so the
section is its real height from the first paint, and pages/home.js takes
them over without a change. These tests hold the markup to the shared cases
(event_pinned_vectors.json, which app/tests/js/home_event_log.mjs holds the
script's rows to), the rows to the feed's pinned items, and the page render
to writing them only on Home and only when the log is shown.
"""
import asyncio
import json
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

from app import home_event_log
from app.tests import helpers

try:
    from app.models import StatusUpdate
    from app.services import status_feed
    from app.tests.test_pages import ADMIN, render, static_text
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

TESTS = Path(__file__).resolve().parent
VECTORS = json.loads((TESTS / "event_pinned_vectors.json").read_text(encoding="utf-8"))
T0 = datetime(2026, 10, 1, 12, 0, 0)
KUMA_URL = "http://kuma.test:3001"


class SharedCases(unittest.TestCase):
    def test_every_case(self):
        for c in VECTORS["cases"]:
            with self.subTest(c["why"]):
                self.assertEqual(home_event_log.render_pinned(c["open"], VECTORS["now_ms"]), c["html"])

    def test_the_cases_cover_what_can_drift(self):
        whys = " | ".join(c["why"] for c in VECTORS["cases"])
        for topic in ("an outage", "important note", "just now", "minutes", "hours", "yesterday", "days",
                      "escaping", "no start time", "mixed", "same moment", "milliseconds", "nothing pinned"):
            self.assertIn(topic, whys)

    def test_the_empty_list_is_the_one_in_the_page(self):
        page = (TESTS.parent / "static" / "index.html").read_text(encoding="utf-8")
        self.assertEqual(page.count(home_event_log.PINNED_EMPTY), 1)
        # Under the heading, above the wheel.
        self.assertLess(page.index('id="eventLogTitle"'), page.index(home_event_log.PINNED_EMPTY))
        self.assertLess(page.index(home_event_log.PINNED_EMPTY), page.index("data-event-wheel"))

    def test_times_say_what_the_wheel_says(self):
        now = VECTORS["now_ms"]
        for secs, want in ((0, "just now"), (44, "just now"), (45, "1 min ago"), (89, "1 min ago"),
                           (90, "2 min ago"), (59 * 60 + 29, "59 min ago"), (59 * 60 + 30, "1 h ago"),
                           (23 * 3600 + 29 * 60, "23 h ago"), (23 * 3600 + 30 * 60, "yesterday"),
                           (35 * 3600, "yesterday"), (35 * 3600 + 30 * 60, "2 days ago"), (-120, "just now")):
            with self.subTest(secs):
                self.assertEqual(home_event_log.wheel_time(now - secs * 1000, now), want)

    def test_text_is_escaped(self):
        row = home_event_log.render_pinned([{"id": 1, "source": "admin", "text": '<img src=x onerror=alert(1)>"',
                                             "important": True, "resolved": False,
                                             "created_at": "2026-10-01T12:00:00.000Z"}], VECTORS["now_ms"])
        self.assertNotIn("<img", row)
        self.assertIn('title="&lt;img src=x onerror=alert(1)&gt;&quot;"', row)
        self.assertIn('</span>&lt;img src=x onerror=alert(1)&gt;"</span>', row)

    def test_what_is_not_pinned_has_no_row(self):
        items = [{"id": 1, "source": "library", "text": "Added: Dune", "resolved": True,
                  "created_at": "2026-10-01T12:00:00.000Z"},
                 {"id": 2, "source": "auto", "text": "Plex is back, down 3 min", "resolved": True,
                  "started_at": "2026-10-01T12:00:00.000Z"},
                 {"id": 3, "source": "auto", "text": "", "resolved": False, "started_at": "2026-10-01T12:00:00.000Z"},
                 {"id": 4, "source": "auto", "text": "Plex is down", "resolved": False, "started_at": None,
                  "created_at": "not a time"}]
        self.assertEqual(home_event_log.render_pinned(items, VECTORS["now_ms"]), home_event_log.PINNED_EMPTY)


class TheJavaScriptSideRuns(unittest.TestCase):
    def test_the_check_reads_the_shared_cases_and_the_real_module(self):
        js = (TESTS / "js" / "home_event_log.mjs").read_text(encoding="utf-8")
        for needle in ("event_pinned_vectors.json", "static/js/pages/home.js",
                       "the script writes exactly the rows the server writes",
                       "taking the server\\'s rows over changes nothing", "process.exit(failed ? 1 : 0)"):
            self.assertIn(needle, js)
        home = (TESTS.parent / "static" / "js" / "pages" / "home.js").read_text(encoding="utf-8")
        self.assertIn("const PINNED_ICON = { down: 'error', important: 'warning' };", home)
        self.assertIn("const PINNED_PREFIX = { down: 'Problem: ', important: 'Important: ' };", home)
        self.assertEqual(home_event_log.PINNED_ICON, {"down": "error", "important": "warning"})
        self.assertEqual(home_event_log.PINNED_PREFIX, {"down": "Problem: ", "important": "Important: "})


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ThePageRender(unittest.TestCase):
    def setUp(self):
        self.page = static_text("index.html")

    def out(self, flags, name="index"):
        return render(ADMIN, name, flags=flags, page=self.page)

    def test_the_rows_replace_the_empty_list(self):
        case = VECTORS["cases"][0]
        out = self.out({"event_pinned": {"items": case["open"], "now_ms": VECTORS["now_ms"]}})
        self.assertIn(case["html"], out)
        self.assertNotIn(home_event_log.PINNED_EMPTY, out)
        log = out[out.index('<section id="homeEventLog"'):out.index("</section>", out.index('<section id="homeEventLog"'))]
        self.assertLess(log.index('id="eventLogTitle"'), log.index('class="ws-pinned"'))
        self.assertLess(log.index('class="ws-pinned"'), log.index("data-event-wheel"))

    def test_nothing_pinned_keeps_the_empty_hidden_list(self):
        for flags in ({}, {"event_pinned": None}, {"event_pinned": {"items": [], "now_ms": 0}}):
            with self.subTest(flags):
                self.assertIn(home_event_log.PINNED_EMPTY, self.out(flags))

    def test_not_written_into_a_hidden_log_or_another_page(self):
        pinned = {"items": VECTORS["cases"][0]["open"], "now_ms": VECTORS["now_ms"]}
        self.assertIn(home_event_log.PINNED_EMPTY, self.out({"feed_off": True, "event_pinned": pinned}))
        self.assertNotIn('class="ws-pinned__row"', self.out({"event_pinned": pinned}, name="news"))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TheRoute(unittest.TestCase):
    """main._event_log_pinned: the feed's open items, as GET /api/status/feed
    sends them in "open", unless the feed would answer "unavailable"."""

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        from app import main
        self.main = main
        p = mock.patch.object(main, "SessionLocal", self.Session)
        p.start()
        self.addCleanup(p.stop)

    def add(self, **fields):
        values = dict(title="t", message="t", update_type="note", severity="info", author_id="",
                      author_name="", active=True, source="admin", important=False, created_at=T0)
        values.update(fields)
        db = self.Session()
        db.add(StatusUpdate(**values))
        db.commit()
        db.close()

    def pinned(self, answering=True):
        with mock.patch.object(status_feed, "kuma_answering", mock.AsyncMock(return_value=answering)):
            return asyncio.run(self.main._event_log_pinned())

    def test_open_outages_and_important_notes_only(self):
        self.add(source="auto", monitor_id=1, service_name="Plex", message="Plex is down", started_at=T0)
        self.add(message="Server move tonight", important=True, created_at=T0 + timedelta(minutes=5))
        self.add(message="A plain note")
        self.add(source="auto", monitor_id=2, service_name="Books", message="Books is back, down 3 min",
                 active=False, started_at=T0, resolved_at=T0)
        got = self.pinned()
        self.assertEqual([i["text"] for i in got["items"]], ["Server move tonight", "Plex is down"])
        self.assertIsInstance(got["now_ms"], int)
        db = self.Session()
        self.assertEqual(got["items"], status_feed.feed(db, 30, T0 + timedelta(hours=1))["open"])
        db.close()

    def test_none_when_the_feed_would_be_unavailable(self):
        db = self.Session()
        helpers.put(db, "integration.uptime_kuma.url", KUMA_URL)
        db.close()
        self.add(source="auto", monitor_id=1, service_name="Plex", message="Plex is down", started_at=T0)
        self.assertEqual(self.pinned(answering=False)["items"], [])
        self.assertEqual(len(self.pinned(answering=True)["items"]), 1)

    def test_without_uptime_kuma_the_rows_still_show(self):
        self.add(message="Server move tonight", important=True)
        self.assertEqual(len(self.pinned(answering=False)["items"]), 1)

    def test_a_database_that_cannot_answer_leaves_them_to_the_page(self):
        with mock.patch.object(self.main, "SessionLocal", side_effect=RuntimeError("no db")):
            self.assertIsNone(self.pinned())

    def test_home_passes_them(self):
        src = Path(self.main.__file__).read_text(encoding="utf-8")
        self.assertIn('"event_pinned": await _event_log_pinned()', src)


if __name__ == "__main__":
    unittest.main()
