"""
Books: taking a book out of the Continue row (PUT and DELETE
/api/books/<id>/continue-hidden, book_personal.hide_from_continue).

The routes run end to end on test_books_api's in-memory catalog (Kavita's and
Plex's reads faked at their function boundaries). What is proven: the book
leaves only this person's row, their place in it (the player's positions and
Kavita's progress) is never touched, the book comes back by itself after newer
activity, a merged id is followed (by the routes, and by a real rebuild that
merges), every write checks same-origin, and two workers starting at once add
the table. No test reaches Kavita, Plex or the dev instance's data.
"""
import tempfile
import unittest
from datetime import datetime, timedelta

from app.tests import helpers  # noqa: F401 - sets up the test environment first

try:
    import httpx  # noqa: F401
    from sqlalchemy import inspect, text
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

if HAVE_APP:
    # Not in the guard above: a missing module of this work must fail the suite, not skip it.
    from app.models import BookContinueHidden, ListeningLog, ListeningPosition
    from app.services import book_catalog, book_personal
    from app.tests.test_book_catalog import STARTUP_CHILD, CatalogCase, audiobook, ebook, run_together
    from app.tests.test_book_personal import PersonalBase
    from app.tests.test_books_api import A, B, kplace, make_book, place, when

HIDE = "/api/books/{}/continue-hidden"


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class HiddenBase(PersonalBase):
    def row(self):
        return self.ok("/api/books/continue")["items"]

    def row_ids(self):
        return [i["book_id"] for i in self.row()]

    def item(self, book_id):
        return next(i for i in self.row() if i["book_id"] == book_id)

    def hide(self, book_id, updated_at, **kw):
        return self.send("PUT", HIDE.format(book_id), {"updated_at": updated_at}, **kw)

    def hide_shown(self, book_id):
        """Take a book out as the page does: with the updated_at its card showed."""
        r = self.hide(book_id, self.item(book_id)["updated_at"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"hidden": True})

    def positions(self):
        db = self.Session()
        try:
            return sorted((p.identity, p.book_key, p.track_key, p.offset_ms, p.updated_at, p.book_ms,
                           p.book_duration_ms) for p in db.query(ListeningPosition))
        finally:
            db.close()

    def log_count(self):
        db = self.Session()
        try:
            return db.query(ListeningLog).count()
        finally:
            db.close()

    def listen_on(self, identity, key, at, book_ms=None):
        """The listener carried on: their stored place moves (as a check-in would)."""
        db = self.Session()
        try:
            p = db.query(ListeningPosition).filter_by(identity=identity, book_key=key).one()
            p.updated_at = at
            if book_ms is not None:
                p.book_ms = book_ms
            db.commit()
        finally:
            db.close()

    def hidden_rows(self):
        db = self.Session()
        try:
            return sorted((h.identity, h.book_id, h.activity_at) for h in db.query(BookContinueHidden))
        finally:
            db.close()


class Hide(HiddenBase):
    def setUp(self):
        super().setUp()
        place(self.db, "plex:1001", "14:1", when(41), book_ms=100_000, duration=7_300_000)     # 7 The Hobbit
        place(self.db, "plex:1001", "13:1", when(40), book_ms=500_000, duration=4_100_000)     # 6 Villette

    def test_the_book_leaves_the_row_and_undo_brings_it_back(self):
        self.assertEqual(self.row_ids(), [7, 6])
        self.hide_shown(7)
        self.assertEqual(self.row_ids(), [6])
        self.assertEqual(self.done("DELETE", HIDE.format(7)), {"hidden": False})
        self.assertEqual(self.row_ids(), [7, 6])

    def test_the_place_in_the_book_is_never_touched(self):
        before, logged = self.positions(), self.log_count()
        detail = self.ok("/api/books/7")
        self.hide_shown(7)
        self.assertEqual(self.positions(), before)
        self.assertEqual(self.log_count(), logged)
        # The book page still offers the same place to resume from.
        self.assertEqual(self.ok("/api/books/7"), detail)
        self.done("DELETE", HIDE.format(7))
        self.assertEqual(self.positions(), before)

    def test_listening_further_brings_it_back(self):
        self.hide_shown(7)
        self.listen_on("plex:1001", "14:1", when(41))                                  # the same moment: still out
        self.assertEqual(self.row_ids(), [6])
        self.listen_on("plex:1001", "14:1", when(41) + timedelta(seconds=30), book_ms=130_000)
        self.assertEqual(self.row_ids(), [7, 6])
        self.assertEqual(self.item(7)["progress_label"], "2h left")

    def test_the_comparison_is_to_the_millisecond_the_row_shows(self):
        # Stored with microseconds; the card's updated_at has milliseconds. The
        # book must not come back on the next read for the part the card cut off.
        self.listen_on("plex:1001", "14:1", when(41) + timedelta(microseconds=123_456))
        self.assertEqual(self.item(7)["updated_at"], "2026-10-12T12:00:00.123Z")
        self.hide_shown(7)
        self.assertEqual(self.row_ids(), [6])
        self.listen_on("plex:1001", "14:1", when(41) + timedelta(microseconds=124_000))
        self.assertEqual(self.row_ids(), [7, 6])

    def test_hiding_again_keeps_the_newer_time(self):
        self.hide_shown(7)
        self.assertEqual(self.hide(7, "2026-10-01T00:00:00.000Z").status_code, 200)    # an older card
        self.assertEqual(self.row_ids(), [6])
        self.assertEqual(self.hidden_rows(), [("plex:1001", 7, when(41))])

    def test_a_hidden_book_does_not_take_a_slot(self):
        for n in range(13):
            make_book(self.db, 200 + n, f"Book {n}", "Many", editions=[(f"{300 + n}:1", "N")])
            place(self.db, "plex:1001", f"{300 + n}:1", when(100 + n), book_ms=1000, duration=10_000_000)
        self.assertEqual(len(self.row()), 12)
        self.hide_shown(212)
        ids = self.row_ids()
        self.assertEqual(len(ids), 12)
        self.assertNotIn(212, ids)
        self.assertEqual(ids[-1], 200)                                                  # the next one moves up

    def test_another_persons_row_is_theirs_alone(self):
        place(self.db, "plex:1002", "14:1", when(42), book_ms=100_000, duration=7_300_000)
        self.hide_shown(7)
        self.as_user(B)
        self.assertEqual(self.row_ids(), [7])
        # B's undo and B's own hide touch nothing of A's.
        self.done("DELETE", HIDE.format(7))
        self.hide_shown(7)
        self.assertEqual(self.row_ids(), [])
        self.done("DELETE", HIDE.format(7))
        self.assertEqual(self.row_ids(), [7])
        self.as_user(A)
        self.assertEqual(self.row_ids(), [6])

    def test_a_merged_id_is_the_surviving_book(self):
        place(self.db, "plex:1001", "10:1", when(50), book_ms=1_000_000, duration=10_000_000)    # 1 Dune
        shown = self.item(1)["updated_at"]
        self.assertEqual(self.hide(9, shown).status_code, 200)                         # 9 is a ghost of 1
        self.assertEqual(self.hidden_rows(), [("plex:1001", 1, when(50))])
        self.assertNotIn(1, self.row_ids())
        self.done("DELETE", HIDE.format(9))
        self.assertIn(1, self.row_ids())

    def test_input_is_checked(self):
        # The last two parse, but their offset takes them outside datetime's range.
        for bad in ("yesterday", "2026-13-01T00:00:00Z", "x" * 41, 5,
                    "0001-01-01T00:00:00+01:00", "9999-12-31T23:59:59-01:00"):
            with self.subTest(updated_at=bad):
                self.assertEqual(self.send("PUT", HIDE.format(7), {"updated_at": bad}).status_code, 422)
        self.assertEqual(self.send("PUT", HIDE.format(0), {"updated_at": None}).status_code, 422)
        self.assertEqual(self.send("PUT", HIDE.format(2 ** 31), {"updated_at": None}).status_code, 422)
        self.assertEqual(self.hide(5, None).status_code, 404)                          # a book they cannot see
        self.assertEqual(self.hide(999, None).status_code, 404)
        self.assertEqual(self.hidden_rows(), [])
        self.assertEqual(self.row_ids(), [7, 6])

    def test_every_write_checks_same_origin(self):
        for method, body in (("PUT", {"updated_at": None}), ("DELETE", None)):
            for origin in (None, "https://evil.example", "null"):
                with self.subTest(method=method, origin=origin):
                    self.assertEqual(self.send(method, HIDE.format(7), body, origin=origin).status_code, 403)
        self.assertEqual(self.hidden_rows(), [])

    def test_a_session_with_no_identity_owns_nothing(self):
        self.as_user({"user_id": "", "username": "x", "is_admin": "false", "auth_method": "oidc", "email": ""})
        self.assertIn(self.hide(7, None).status_code, (403, 404))
        self.assertEqual(self.send("DELETE", HIDE.format(7)).status_code, 403)
        self.assertEqual(self.hidden_rows(), [])



@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Ebooks(HiddenBase):
    def setUp(self):
        super().setUp()
        self.in_progress.return_value = [1101, 1102]

    def test_reading_further_brings_an_ebook_back(self):
        self.places.return_value = {101: kplace(20, 41, when(60), 101)}
        self.hide_shown(1)
        self.assertEqual(self.row_ids(), [])
        self.places.return_value = {101: kplace(22, 41, when(61), 101)}
        self.assertEqual(self.row_ids(), [1])

    def test_a_place_with_no_time_stays_out_until_one_with_a_time(self):
        self.places.return_value = {101: kplace(20, 41, None, 101)}
        self.assertIsNone(self.item(1)["updated_at"])
        self.hide_shown(1)
        self.assertEqual(self.row_ids(), [])
        self.places.return_value = {101: kplace(21, 41, when(62), 101)}
        self.assertEqual(self.row_ids(), [1])

    def test_listening_to_a_book_taken_out_as_an_ebook_brings_it_back(self):
        self.places.return_value = {101: kplace(20, 41, when(60), 101)}
        place(self.db, "plex:1001", "10:1", when(55), book_ms=1_000_000, duration=10_000_000)
        self.assertEqual([(i["book_id"], i["format"]) for i in self.row()], [(1, "ebook")])
        self.hide_shown(1)
        self.assertEqual(self.row_ids(), [])
        self.listen_on("plex:1001", "10:1", when(63))
        self.assertEqual([(i["book_id"], i["format"]) for i in self.row()], [(1, "audio")])


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Service(HiddenBase):
    def test_an_id_a_hidden_row_names_is_never_handed_to_a_new_book(self):
        db = self.Session()
        try:
            book_personal.hide_from_continue(db, "plex:1001", 500, None)
            self.assertEqual(book_personal.next_book_id(db), 501)
        finally:
            db.close()

    def test_to_ms(self):
        self.assertEqual(book_personal.to_ms(None), datetime.min)
        self.assertEqual(book_personal.to_ms(datetime(2026, 1, 1, 0, 0, 0, 999_999)), datetime(2026, 1, 1, 0, 0, 0, 999_000))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class MergeFollows(CatalogCase):
    """A rebuild that merges two books moves the hidden rows with it."""

    def setUp(self):
        super().setUp()
        self.sources.ebooks = [ebook(7, "Dune")]
        self.sources.audiobooks = [audiobook("10:1", "Dune")]
        self.override(7, "10:1", "apart")
        self.rebuild()
        live = self.live()
        self.ebook_id, self.audio_id = live[(7, None)], live[(None, "10:1")]

    def merge(self):
        db = self.db()
        try:
            book_catalog.remove_override(db, 7, "10:1")
        finally:
            db.close()
        self.rebuild()
        self.assertEqual(self.book(self.ebook_id).merged_into, self.audio_id)

    def rows(self):
        db = self.db()
        try:
            return sorted((h.identity, h.book_id, h.activity_at) for h in db.query(BookContinueHidden))
        finally:
            db.close()

    def test_rows_move_and_the_newer_activity_is_kept(self):
        t = datetime(2026, 9, 1)
        db = self.db()
        try:
            db.add_all([
                BookContinueHidden(identity="plex:1", book_id=self.ebook_id, activity_at=t + timedelta(days=2), hidden_at=t),
                BookContinueHidden(identity="plex:1", book_id=self.audio_id, activity_at=t, hidden_at=t),
                BookContinueHidden(identity="plex:2", book_id=self.ebook_id, activity_at=None, hidden_at=t),
                BookContinueHidden(identity="plex:3", book_id=self.audio_id, activity_at=t, hidden_at=t)])
            db.commit()
        finally:
            db.close()
        self.merge()
        self.assertEqual(self.rows(), [("plex:1", self.audio_id, t + timedelta(days=2)),
                                       ("plex:2", self.audio_id, None),
                                       ("plex:3", self.audio_id, t)])
        self.rebuild()                                                                   # a second rebuild moves nothing
        self.assertEqual(len(self.rows()), 3)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Migration(unittest.TestCase):
    def test_two_workers_starting_at_once_add_the_table(self):
        from app import models  # noqa: F401 - registers the tables
        from app.database import Base, make_engine

        with tempfile.TemporaryDirectory() as tmp:
            url = f"sqlite:///{tmp}/old.db"
            engine = make_engine(url)
            Base.metadata.create_all(bind=engine, tables=[t for t in Base.metadata.sorted_tables
                                                          if t.name != "book_continue_hidden"])
            with engine.begin() as conn:
                conn.execute(text("INSERT INTO listening_positions (identity, book_key, track_key, offset_ms, "
                                  "duration_ms, updated_at, device, source) VALUES ('plex:1', '10:1', 't', 5, 0, "
                                  "'2026-01-01 00:00:00', '', 'web')"))
            self.assertNotIn("book_continue_hidden", inspect(engine).get_table_names())
            self.assertEqual(run_together([STARTUP_CHILD, STARTUP_CHILD], url), ["started", "started"])
            run_together([STARTUP_CHILD], url)
            self.assertIn("book_continue_hidden", inspect(engine).get_table_names())
            uniques = {tuple(u["column_names"]) for u in inspect(engine).get_unique_constraints("book_continue_hidden")}
            with engine.connect() as conn:
                kept = conn.execute(text("SELECT offset_ms FROM listening_positions WHERE identity = 'plex:1'")).scalar()
            engine.dispose()
        self.assertEqual(kept, 5)
        self.assertIn(("identity", "book_id"), uniques)


if __name__ == "__main__":
    unittest.main()
