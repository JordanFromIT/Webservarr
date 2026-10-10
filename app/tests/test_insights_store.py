"""
Insights tracking, the second half (docs/superpowers/specs/2026-10-10-insights-design.md,
sections 4.3, 4.4 and 5): who asked for which book, the Kavita account each
person connected, their Kavita totals once a day and their place in each
ebook, each written by a route that already runs and never failing it.
"""
import logging
import unittest
from datetime import date, datetime, timedelta
from unittest import mock

try:
    from sqlalchemy.exc import OperationalError
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False
if HAVE_APP:
    from app.models import Book, BookRequester, EbookPlace, KavitaLink, ReadingTotal, Setting
    from app.services import insights_store as store

ME = "plex:4242"
NOW = datetime(2026, 10, 10, 12, 30)
PLEX_USER = {"username": "sam", "display_name": "Sam", "is_admin": "false", "auth_method": "plex",
             "plex_account_id": "4242", "email": "sam@example.com"}


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Base(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.addCleanup(self.db.close)

    def count(self, model):
        self.db.expire_all()
        return self.db.query(model).count()


class Writers(Base):
    def test_a_request_needs_an_identity_a_book_and_a_known_format(self):
        self.assertTrue(store.record_request(self.db, ME, " gr:1 ", "Dune", "both", now=NOW))
        for identity, book, fmt in (("", "gr:1", "ebook"), (ME, "  ", "ebook"), (ME, "gr:1", "vinyl")):
            self.assertFalse(store.record_request(self.db, identity, book, "Dune", fmt, now=NOW))
        row = self.db.query(BookRequester).one()
        self.assertEqual((row.identity, row.foreign_id, row.title, row.format, row.requested_at),
                         (ME, "gr:1", "Dune", "both", NOW))

    def test_the_kavita_link_keeps_only_the_id_and_username(self):
        self.assertTrue(store.record_kavita_link(self.db, ME, {"id": 7, "username": "sam", "apiKey": "KEY-SENTINEL"},
                                                 now=NOW))
        self.assertTrue(store.record_kavita_link(self.db, ME, {"id": 8, "username": "sam2"}, now=NOW))
        row = self.db.query(KavitaLink).one()
        self.assertEqual((row.kavita_user_id, row.kavita_username), (8, "sam2"))
        self.assertNotIn("KEY-SENTINEL", repr([getattr(row, c) for c in ("identity", "kavita_username")]))
        self.assertFalse(store.record_kavita_link(self.db, ME, {"apiKey": "x"}))
        self.assertFalse(store.record_kavita_link(self.db, "", {"id": 1}))
        self.assertFalse(store.record_kavita_link(self.db, ME, {"id": True, "username": ""}))

    def test_one_totals_row_a_day_and_the_latest_read_wins(self):
        self.assertFalse(store.has_reading_today(self.db, ME, now=NOW))
        store.record_reading_totals(self.db, ME, {"pages": 100, "words": 9, "hours": 2}, now=NOW)
        store.record_reading_totals(self.db, ME, {"pages": 120, "words": 10, "hours": 3}, now=NOW + timedelta(hours=1))
        store.record_reading_totals(self.db, ME, {"pages": 130, "words": -1, "hours": "x"},
                                    now=NOW + timedelta(days=1))
        rows = [(r.day, r.pages, r.words, r.hours) for r in self.db.query(ReadingTotal).order_by(ReadingTotal.day)]
        self.assertEqual(rows, [(date(2026, 10, 10), 120, 10, 3), (date(2026, 10, 11), 130, 0, 0)])
        self.assertTrue(store.has_reading_today(self.db, ME, now=NOW))

    def test_ebook_places_are_replaced_in_place(self):
        at = datetime(2026, 10, 9, 20, 0)
        self.assertEqual(store.record_ebook_places(self.db, ME, {1: {"page": 40, "pages": 300, "at": at},
                                                                 "x": {"page": 1}, 2: "not a place"}, now=NOW), 1)
        store.record_ebook_places(self.db, ME, {1: {"page": 60, "pages": 300, "at": None}}, now=NOW)
        row = self.db.query(EbookPlace).one()
        self.assertEqual((row.book_id, row.page, row.pages, row.read_at, row.seen_at), (1, 60, 300, None, NOW))

    def test_best_effort_logs_and_rolls_back(self):
        def broken(db, *args):
            raise OperationalError("INSERT", {}, Exception("locked"))
        with self.assertLogs("app.services.insights_store", level=logging.WARNING) as logs:
            self.assertIsNone(store.best_effort(self.db, "a test row", broken, ME))
        self.assertIn("OperationalError", logs.output[0])
        self.assertNotIn(ME, logs.output[0])


class Prune(Base):
    def test_two_years_then_gone(self):
        old, kept = NOW - timedelta(days=731), NOW - timedelta(days=700)
        for book_id, at in ((1, old), (2, kept)):
            store.record_request(self.db, ME, "gr:1", "Dune", "ebook", now=at)
            store.record_reading_totals(self.db, ME, {"pages": 1}, now=at)
            store.record_ebook_places(self.db, ME, {book_id: {"page": 1, "pages": 2}}, now=at)
        store.record_kavita_link(self.db, ME, {"id": 7, "username": "sam"}, now=old)
        self.assertEqual(store.prune(self.db, now=NOW), 3)
        self.assertEqual([self.count(m) for m in (BookRequester, ReadingTotal, EbookPlace, KavitaLink)], [1, 1, 1, 1])


class Started(Base):
    def test_the_start_date_is_written_once(self):
        from app.seed import migrate_insights_started_v1
        self.assertIsNone(store.tracking_started(self.db))
        with mock.patch.object(store, "now_utc", return_value=NOW):
            migrate_insights_started_v1(self.db)
        with mock.patch.object(store, "now_utc", return_value=NOW + timedelta(days=3)):
            migrate_insights_started_v1(self.db)
        self.assertEqual(store.tracking_started(self.db), date(2026, 10, 10))


class Routes(Base):
    """Each writer's hook, through the real route, with the outside world faked."""

    def setUp(self):
        super().setUp()
        setup_done = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        setup_done.start()
        self.addCleanup(setup_done.stop)
        self.addCleanup(helpers.reset_overrides)

    def client(self, scope=None):
        from app.main import app
        from app.routers import books
        c = helpers.api_client(self.Session, user=dict(PLEX_USER), headers=helpers.SAME_ORIGIN)
        if scope is not None:
            app.dependency_overrides[books.caller] = lambda: scope
        return c

    def scope(self):
        from app.routers.books import Scope
        return Scope(identity=ME, series={9}, kavita=("http://kavita.test", "t"), audio=False)

    def test_a_book_request_records_who_asked(self):
        from app.routers import integrations
        answers = [{"ok": True, "message": "Book requested", "title": "Dune", "state": "requested", "book_ids": [5]},
                   {"ok": True, "message": "Already in the library", "state": "available"}]
        with mock.patch.object(integrations, "_enforce_daily_book_cap", mock.AsyncMock()), \
                mock.patch("app.integrations.chaptarr.request_book", mock.AsyncMock(side_effect=answers)):
            c = self.client()
            for _ in answers:
                self.assertEqual(c.post("/api/integrations/chaptarr-request",
                                        json={"bookId": "gr:1", "format": "both"}).status_code, 200)
        row = self.db.query(BookRequester).one()
        self.assertEqual((row.identity, row.foreign_id, row.title, row.format), (ME, "gr:1", "Dune", "both"))

    def test_a_request_still_answers_when_the_record_fails(self):
        from app.routers import integrations
        answer = {"ok": True, "message": "Book requested", "title": "Dune", "state": "requested", "book_ids": [5]}
        with mock.patch.object(integrations, "_enforce_daily_book_cap", mock.AsyncMock()), \
                mock.patch("app.integrations.chaptarr.request_book", mock.AsyncMock(return_value=answer)), \
                mock.patch.object(store, "record_request", side_effect=OperationalError("INSERT", {}, Exception("x"))):
            r = self.client().post("/api/integrations/chaptarr-request", json={"bookId": "gr:1", "format": "ebook"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.count(BookRequester), 0)

    def test_your_stats_keeps_todays_totals(self):
        from app.integrations import kavita
        totals = {"pages": 120, "words": 3000, "hours": 4}
        with mock.patch.object(kavita, "reading_stats", mock.AsyncMock(return_value=totals)):
            r = self.client(self.scope()).get("/api/books/me/stats")
        self.assertEqual(r.status_code, 200)
        self.assertEqual([(t.identity, t.pages) for t in self.db.query(ReadingTotal)], [(ME, 120)])

    def add_ebook(self):
        self.db.add(Book(id=1, title="Dune", sort_title="Dune", author="Frank Herbert", series="",
                         description="", kavita_chapter_id=11, kavita_series_id=9, kavita_volume_id=None,
                         cover_source="kavita", updated_at=NOW, ebook_added_at=NOW, added_at=NOW))
        self.db.commit()

    def test_the_continue_row_keeps_places_and_reads_totals_once_a_day(self):
        from app.integrations import kavita
        from app.routers import books
        self.add_ebook()
        place = {"page": 40, "pages": 300, "at": datetime(2026, 10, 9, 20, 0), "toc_chapter": 11, "toc_page": 40}
        totals = mock.AsyncMock(return_value={"pages": 500, "words": 1, "hours": 9})
        with mock.patch.object(kavita, "in_progress_series_ids", mock.AsyncMock(return_value=[9])), \
                mock.patch.object(kavita, "book_places", mock.AsyncMock(return_value={11: place})), \
                mock.patch.object(kavita, "chapter_number_at", mock.AsyncMock(return_value=None)), \
                mock.patch.object(kavita, "reading_stats", totals), \
                mock.patch.object(books, "SessionLocal", self.Session):
            c = self.client(self.scope())
            self.assertEqual(c.get("/api/books/continue").status_code, 200)
            self.assertEqual(c.get("/api/books/continue").status_code, 200)
        row = self.db.query(EbookPlace).one()
        self.assertEqual((row.identity, row.book_id, row.page, row.pages), (ME, 1, 40, 300))
        self.assertEqual(totals.await_count, 1)
        self.assertEqual([t.pages for t in self.db.query(ReadingTotal)], [500])

    def test_the_kavita_account_is_remembered_at_connect(self):
        import inspect
        from app.routers import kavita_proxy
        with mock.patch.object(kavita_proxy, "SessionLocal", self.Session):
            kavita_proxy._remember_kavita_account(dict(PLEX_USER), {"id": 7, "username": "sam", "apiKey": "K"})
            kavita_proxy._remember_kavita_account({"auth_method": "simple"}, {"id": 8, "username": "x"})
        self.assertEqual([(r.identity, r.kavita_user_id) for r in self.db.query(KavitaLink)], [(ME, 7)])
        self.assertIn("_remember_kavita_account(session, kavita_account)", inspect.getsource(kavita_proxy.signin_oidc))


if __name__ == "__main__":
    unittest.main()
