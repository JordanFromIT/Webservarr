"""
The audiobook player's store (app/services/listening.py): listening positions,
the check-in log, player preferences, log pruning, and the audiobook library
setting that turns the player on.

Everything is keyed by account identity ("plex:<id>"), never username. A
page session (psid) numbers its check-ins (seq): an older seq from the same
psid never overwrites the stored position, and across page sessions or
devices the most recently received check-in wins.
"""
import unittest
from datetime import datetime, timedelta
from unittest import mock

try:
    from app.tests import helpers
    from app import settings_registry as reg
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False
if HAVE_APP:
    from app.services import listening

ME = "plex:1001"
THEM = "plex:2002"
BOOK = "5001"
LIB_KEY = "integration.plex.audiobook_library"


def checkin(db, identity=ME, book=BOOK, track="6001", offset_ms=1000, duration_ms=60000,
            event="checkin", device="Chrome on Android", psid="p-one", seq=1, **kw):
    return listening.save_checkin(db, identity, book, track, offset_ms, duration_ms,
                                  event, device, psid, seq, **kw)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class StoreBase(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()

    def tearDown(self):
        self.db.close()

    def log_count(self, identity=ME, book=BOOK):
        return len(listening.get_history(self.db, identity, book))


class Tables(StoreBase):
    def test_tables_keys_and_index(self):
        from sqlalchemy import inspect
        insp = inspect(self.Session.kw["bind"])
        cols = {c["name"] for c in insp.get_columns("listening_positions")}
        self.assertEqual(cols, {"identity", "book_key", "track_key", "offset_ms", "duration_ms", "updated_at",
                                "device", "device_id", "source", "psid", "seq", "book_ms", "book_duration_ms",
                                "chapter_label", "work_key", "narrator", "linked_from", "book_title"})
        pk = insp.get_pk_constraint("listening_positions")["constrained_columns"]
        uniques = [u["column_names"] for u in insp.get_unique_constraints("listening_positions")]
        self.assertTrue(sorted(pk) == ["book_key", "identity"] or ["identity", "book_key"] in uniques,
                        "one row per identity and book")
        cols = {c["name"] for c in insp.get_columns("listening_log")}
        self.assertEqual(cols, {"id", "identity", "book_key", "track_key", "offset_ms", "device", "device_id",
                                "event", "at", "book_ms", "book_duration_ms", "chapter_label", "work_key",
                                "narrator"})
        self.assertIn(["identity", "book_key", "at"],
                      [i["column_names"] for i in insp.get_indexes("listening_log")])
        self.assertIn(["identity", "work_key"],
                      [i["column_names"] for i in insp.get_indexes("listening_positions")])
        cols = {c["name"] for c in insp.get_columns("player_prefs")}
        self.assertEqual(cols, {"identity", "skip_s", "speed", "smart_rewind"})
        self.assertEqual(insp.get_pk_constraint("player_prefs")["constrained_columns"], ["identity"])


class Positions(StoreBase):
    def test_save_then_get(self):
        out = checkin(self.db, track="6002", offset_ms=123456, duration_ms=3600000, device="Safari on iPhone")
        self.assertTrue(out["stored"])
        self.assertRegex(out["updated_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
        pos = listening.get_position(self.db, ME, BOOK)
        self.assertEqual(pos, {"track": "6002", "offset_ms": 123456, "duration_ms": 3600000,
                               "updated_at": out["updated_at"], "device": "Safari on iPhone", "device_id": None,
                               "source": "web", "psid": "p-one", "book_ms": None, "book_duration_ms": None,
                               "chapter_label": None, "narrator": None, "book_title": None})
        hist = listening.get_history(self.db, ME, BOOK)
        self.assertEqual(len(hist), 1)
        self.assertEqual(hist[0]["event"], "checkin")
        self.assertEqual(hist[0]["offset_ms"], 123456)
        self.assertEqual(hist[0]["track"], "6002")

    def test_no_position_is_none(self):
        self.assertIsNone(listening.get_position(self.db, ME, BOOK))
        self.assertEqual(listening.get_history(self.db, ME, BOOK), [])

    def test_a_newer_seq_from_the_same_psid_overwrites(self):
        checkin(self.db, offset_ms=1000, seq=1)
        self.assertTrue(checkin(self.db, offset_ms=2000, seq=2)["stored"])
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["offset_ms"], 2000)
        self.assertEqual(self.log_count(), 2)

    def test_an_older_seq_from_the_same_psid_is_not_stored_or_logged(self):
        first = checkin(self.db, offset_ms=5000, seq=7)
        late = checkin(self.db, offset_ms=1000, seq=6)
        self.assertFalse(late["stored"])
        self.assertEqual(late["updated_at"], first["updated_at"], "the stored row's timestamp")
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["offset_ms"], 5000)
        self.assertEqual(self.log_count(), 1, "a refused check-in is not logged")

    def test_another_page_stores_over_the_row_it_saw(self):
        first = checkin(self.db, offset_ms=900000, psid="phone", seq=40, device="Chrome on Android")
        # Another page that saw that row (its base), even with a lower seq and
        # an earlier offset: stored.
        out = checkin(self.db, offset_ms=10000, psid="laptop", seq=1, device="Firefox on Linux",
                      base=first["updated_at"])
        self.assertTrue(out["stored"])
        pos = listening.get_position(self.db, ME, BOOK)
        self.assertEqual((pos["offset_ms"], pos["device"]), (10000, "Firefox on Linux"))
        # The stored row now belongs to "laptop": its own older seq is refused...
        self.assertFalse(checkin(self.db, offset_ms=5, psid="laptop", seq=0)["stored"])
        # ...and "phone" coming back with the row it last saw is a conflict...
        stale = checkin(self.db, offset_ms=950000, psid="phone", seq=41, base=first["updated_at"])
        self.assertEqual(stale["conflict"]["offset_ms"], 10000)
        # ...until it sends the row it has now been shown.
        self.assertTrue(checkin(self.db, offset_ms=950000, psid="phone", seq=42, base=out["updated_at"])["stored"])
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["offset_ms"], 950000)
        self.assertEqual(self.log_count(), 4, "the refused older seq is not logged; the conflict is")

    def test_identities_are_isolated(self):
        checkin(self.db, identity=ME, offset_ms=1111, psid="same", seq=5)
        # Same book, same psid and a lower seq: a different identity is its own row.
        self.assertTrue(checkin(self.db, identity=THEM, offset_ms=2222, psid="same", seq=1)["stored"])
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["offset_ms"], 1111)
        self.assertEqual(listening.get_position(self.db, THEM, BOOK)["offset_ms"], 2222)
        self.assertEqual([h["offset_ms"] for h in listening.get_history(self.db, ME, BOOK)], [1111])
        self.assertEqual([h["offset_ms"] for h in listening.get_history(self.db, THEM, BOOK)], [2222])
        listening.put_prefs(self.db, THEM, skip_s=30)
        self.assertEqual(listening.get_prefs(self.db, ME)["skip_s"], 10)
        self.assertEqual(listening.get_prefs(self.db, THEM)["skip_s"], 30)

    def test_books_are_separate_rows(self):
        checkin(self.db, book="5001", offset_ms=1)
        checkin(self.db, book="5002", offset_ms=2, psid="p-one", seq=0)
        self.assertEqual(listening.get_position(self.db, ME, "5001")["offset_ms"], 1)
        self.assertEqual(listening.get_position(self.db, ME, "5002")["offset_ms"], 2)

    def test_history_is_newest_first_and_limited(self):
        for i in range(5):
            checkin(self.db, offset_ms=i * 1000, seq=i, event="play" if i == 0 else "checkin")
        hist = listening.get_history(self.db, ME, BOOK)
        self.assertEqual([h["offset_ms"] for h in hist], [4000, 3000, 2000, 1000, 0])
        self.assertEqual(set(hist[0]), {"track", "offset_ms", "device", "device_id", "event", "at", "book_key",
                                        "book_ms", "book_duration_ms", "chapter_label"})
        self.assertEqual([h["offset_ms"] for h in listening.get_history(self.db, ME, BOOK, limit=2)], [4000, 3000])

    def test_source_is_recorded(self):
        checkin(self.db, source="local")
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["source"], "local")

    def test_bad_input_is_refused(self):
        bad = [
            dict(identity=""), dict(event="rewind"), dict(offset_ms=-1), dict(duration_ms=-5),
            dict(offset_ms=1.5), dict(offset_ms=True), dict(seq=-1), dict(book=""), dict(track=""),
            dict(psid=""), dict(source="kindle"),
        ]
        for kw in bad:
            with self.subTest(kw):
                with self.assertRaises(ValueError):
                    checkin(self.db, **kw)
        self.assertIsNone(listening.get_position(self.db, ME, BOOK))

    def test_every_spec_event_is_accepted(self):
        for i, ev in enumerate(("play", "pause", "checkin", "seek", "jump", "leave", "end")):
            self.assertTrue(checkin(self.db, event=ev, seq=i)["stored"], ev)

    def test_a_long_device_label_is_cut_not_refused(self):
        checkin(self.db, device="x" * 500)
        self.assertLessEqual(len(listening.get_position(self.db, ME, BOOK)["device"]), 80)


class DeviceIds(StoreBase):
    """Each browser's own random id rides on its check-ins, so the handoff
    prompt can tell two devices with one label apart."""

    ID_A = "k3v9x0q2m7w1p4z8r6t5y2u0"
    ID_B = "b" * 40

    def test_the_position_and_the_log_carry_the_id(self):
        checkin(self.db, device_id=self.ID_A)
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["device_id"], self.ID_A)
        self.assertEqual(listening.get_history(self.db, ME, BOOK)[0]["device_id"], self.ID_A)
        page = listening.get_history_page(self.db, ME, BOOK)
        self.assertEqual(page["entries"][0]["device_id"], self.ID_A)

    def test_the_newest_checkin_sets_it_and_none_clears_it(self):
        a = checkin(self.db, device_id=self.ID_A, psid="p-a", seq=1)
        b = checkin(self.db, device_id=self.ID_B, psid="p-b", seq=1, base=a["updated_at"])
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["device_id"], self.ID_B)
        checkin(self.db, psid="p-c", seq=1, base=b["updated_at"])      # an older player that sends none
        self.assertIsNone(listening.get_position(self.db, ME, BOOK)["device_id"])
        self.assertEqual([e["device_id"] for e in listening.get_history(self.db, ME, BOOK)],
                         [None, self.ID_B, self.ID_A])

    def test_a_refused_older_seq_keeps_the_stored_id(self):
        checkin(self.db, device_id=self.ID_A, seq=5)
        self.assertFalse(checkin(self.db, device_id=self.ID_B, seq=4)["stored"])
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["device_id"], self.ID_A)

    def test_a_malformed_id_is_refused(self):
        for bad in ("", "short", "A" * 20, "a" * 41, "abc-def-ghi-jkl-mno", "a" * 15, 12345678901234567, " " + "a" * 20):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    checkin(self.db, device_id=bad)
        self.assertIsNone(listening.get_position(self.db, ME, BOOK))
        self.assertEqual(self.log_count(), 0)


class CompareAndSwap(StoreBase):
    """Spec 11b: across page sessions a check-in is stored only over the row
    its page last saw (base); the same page session (psid), or no row yet,
    always stores. A device id alone is not enough: another tab or a reload
    of the same browser is another page session."""

    PHONE = "p" * 20
    DESK = "d" * 20

    def row(self):
        return listening.get_position(self.db, ME, BOOK)

    def test_no_row_stores_whatever_the_base(self):
        self.assertTrue(checkin(self.db, device_id=self.PHONE, base="2026-01-01T00:00:00.000Z")["stored"])
        self.assertTrue(checkin(self.db, book="5002", device_id=self.PHONE)["stored"])

    def test_a_new_page_of_the_same_device_stores_over_the_row_it_saw(self):
        first = checkin(self.db, device_id=self.PHONE, psid="tab-1", offset_ms=1000)
        # A reload: a new psid, the same device, and the row's time from its open.
        self.assertTrue(checkin(self.db, device_id=self.PHONE, psid="tab-2", seq=1, offset_ms=2000,
                                base=first["updated_at"])["stored"])
        self.assertEqual(self.row()["offset_ms"], 2000)

    def test_a_stale_tab_of_the_same_browser_is_a_conflict(self):
        # Two tabs of one browser (one device id): tab 1 saved and sat paused;
        # tab 2 opened from that row and listened on.
        tab1 = checkin(self.db, device_id=self.PHONE, psid="tab-1", offset_ms=320000)
        tab2 = checkin(self.db, device_id=self.PHONE, psid="tab-2", seq=1, offset_ms=610000,
                       base=tab1["updated_at"])
        self.assertTrue(tab2["stored"])
        # Tab 1's Play, with the row it last saw (or none, or an old one): refused.
        for base in (tab1["updated_at"], None, "2020-01-01T00:00:00.000Z"):
            with self.subTest(base=base):
                out = checkin(self.db, device_id=self.PHONE, psid="tab-1", seq=2, offset_ms=320250, base=base)
                self.assertFalse(out["stored"])
                self.assertEqual(out["conflict"]["offset_ms"], 610000)
        self.assertEqual(self.row()["offset_ms"], 610000)
        # Shown tab 2's row, tab 1 may go on.
        self.assertTrue(checkin(self.db, device_id=self.PHONE, psid="tab-1", seq=3, offset_ms=320500,
                                base=tab2["updated_at"])["stored"])

    def test_another_device_without_the_rows_time_is_a_conflict(self):
        desk = checkin(self.db, device_id=self.DESK, psid="desk", offset_ms=600000, device="Chrome on Linux")
        for base in (None, "2026-01-01T00:00:00.000Z"):
            with self.subTest(base=base):
                out = checkin(self.db, device_id=self.PHONE, psid="phone", offset_ms=100000, base=base,
                              device="Chrome on Android")
                self.assertFalse(out["stored"])
                self.assertEqual(out["conflict"], {"track": "6001", "offset_ms": 600000, "device": "Chrome on Linux",
                                                   "updated_at": desk["updated_at"]})
                self.assertEqual(out["updated_at"], desk["updated_at"])
        # Nothing stored; each attempt logged.
        self.assertEqual((self.row()["offset_ms"], self.row()["device_id"]), (600000, self.DESK))
        hist = listening.get_history(self.db, ME, BOOK)
        self.assertEqual([(h["offset_ms"], h["device_id"]) for h in hist],
                         [(100000, self.PHONE), (100000, self.PHONE), (600000, self.DESK)])

    def test_another_device_with_the_rows_time_stores(self):
        desk = checkin(self.db, device_id=self.DESK, psid="desk", offset_ms=600000)
        out = checkin(self.db, device_id=self.PHONE, psid="phone", offset_ms=100000, base=desk["updated_at"])
        self.assertTrue(out["stored"])
        self.assertEqual((self.row()["offset_ms"], self.row()["device_id"]), (100000, self.PHONE))
        # The desk's base is now stale.
        self.assertIn("conflict", checkin(self.db, device_id=self.DESK, psid="desk", seq=2, offset_ms=700000,
                                          base=desk["updated_at"]))

    def test_the_rows_time_matches_to_the_millisecond(self):
        from app.models import ListeningPosition
        checkin(self.db, device_id=self.DESK, psid="desk", offset_ms=600000)
        row = self.db.query(ListeningPosition).one()
        row.updated_at = datetime(2026, 9, 29, 12, 0, 0, 123456)
        self.db.commit()
        self.assertIn("conflict", checkin(self.db, device_id=self.PHONE, psid="phone", base="2026-09-29T12:00:00.122Z"))
        self.assertIn("conflict", checkin(self.db, device_id=self.PHONE, psid="phone", base="2026-09-29T12:00:00.124Z"))
        self.assertTrue(checkin(self.db, device_id=self.PHONE, psid="phone", base="2026-09-29T12:00:00.123Z")["stored"])

    def test_without_ids_the_psid_is_the_device(self):
        first = checkin(self.db, psid="page-1", offset_ms=1000)
        self.assertTrue(checkin(self.db, psid="page-1", seq=2, offset_ms=2000)["stored"])
        self.assertIn("conflict", checkin(self.db, psid="page-2", offset_ms=9000))
        self.assertIn("conflict", checkin(self.db, psid="page-2", offset_ms=9000, base=first["updated_at"]))
        now = self.row()["updated_at"]
        self.assertTrue(checkin(self.db, psid="page-2", offset_ms=9000, base=now)["stored"])

    def test_one_side_without_an_id_falls_back_to_the_psid(self):
        checkin(self.db, device_id=self.DESK, psid="desk", offset_ms=1000)
        self.assertTrue(checkin(self.db, psid="desk", seq=2, offset_ms=2000)["stored"])       # an older page script
        self.assertTrue(checkin(self.db, device_id=self.DESK, psid="desk", seq=3, offset_ms=3000)["stored"])
        self.assertIn("conflict", checkin(self.db, psid="other", offset_ms=4000))
        # A row from a page without an id takes the same psid with an id.
        checkin(self.db, book="5002", psid="old-page", offset_ms=1)
        self.assertTrue(checkin(self.db, book="5002", device_id=self.PHONE, psid="old-page", seq=2, offset_ms=2)["stored"])

    def test_an_older_seq_is_still_refused_not_a_conflict(self):
        checkin(self.db, device_id=self.PHONE, psid="phone", seq=5, offset_ms=5000)
        out = checkin(self.db, device_id=self.PHONE, psid="phone", seq=4, offset_ms=4000)
        self.assertEqual(set(out), {"stored", "updated_at"})
        self.assertFalse(out["stored"])
        self.assertEqual(self.log_count(), 1)

    def test_the_conflict_is_only_ever_the_listeners_own_row(self):
        checkin(self.db, identity=THEM, device_id=self.DESK, psid="desk", offset_ms=600000)
        # ME has no row for the book: another identity's never counts.
        self.assertTrue(checkin(self.db, identity=ME, device_id=self.PHONE, psid="phone", offset_ms=100)["stored"])
        self.assertEqual(listening.get_position(self.db, THEM, BOOK)["offset_ms"], 600000)

    def test_a_bad_base_is_refused(self):
        for bad in ("yesterday", "", "2026-13-01T00:00:00Z", "x" * 41, 12, ["2026-01-01"],
                    "9999-12-31T23:59:59.999Z", "0001-01-01T00:00:00+01:00", "9999-12-31T23:59:59.999-01:00"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    checkin(self.db, base=bad)
        self.assertIsNone(self.row())


WORK_A = "a1" * 16
WORK_B = "b2" * 16


class BookFields(StoreBase):
    """Spec 2.5: every save and every log row records the place in terms
    that survive the book's files being replaced."""

    FIELDS = dict(book_ms=4_000_000, chapter_label="Chapter 9: The Tide Mill", book_duration_ms=36_000_000,
                  work_key=WORK_A, narrator="Tamsin Ashby")

    def test_they_round_trip_through_the_position_and_the_log(self):
        checkin(self.db, **self.FIELDS)
        pos = listening.get_position(self.db, ME, BOOK)
        self.assertEqual({k: pos[k] for k in ("book_ms", "book_duration_ms", "chapter_label", "narrator")},
                         {"book_ms": 4_000_000, "book_duration_ms": 36_000_000,
                          "chapter_label": "Chapter 9: The Tide Mill", "narrator": "Tamsin Ashby"})
        from app.models import ListeningLog, ListeningPosition
        self.assertEqual(self.db.query(ListeningPosition).one().work_key, WORK_A)
        log = self.db.query(ListeningLog).one()
        self.assertEqual((log.book_ms, log.book_duration_ms, log.chapter_label, log.work_key, log.narrator),
                         (4_000_000, 36_000_000, "Chapter 9: The Tide Mill", WORK_A, "Tamsin Ashby"))
        entry = listening.get_history_page(self.db, ME, BOOK)["entries"][0]
        self.assertEqual({k: entry[k] for k in ("book_key", "book_ms", "book_duration_ms", "chapter_label")},
                         {"book_key": BOOK, "book_ms": 4_000_000, "book_duration_ms": 36_000_000,
                          "chapter_label": "Chapter 9: The Tide Mill"})
        self.assertNotIn("earlier_copy", entry)

    def test_book_ms_past_the_length_stores_the_length(self):
        checkin(self.db, book_ms=50_000_000, book_duration_ms=36_000_000)
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["book_ms"], 36_000_000)
        self.assertEqual(listening.get_history(self.db, ME, BOOK)[0]["book_ms"], 36_000_000)
        # The edges, and a length that is not known this time: the row's
        # kept length still bounds it (see test_book_ms_is_clamped_to_the_length_the_row_keeps).
        checkin(self.db, seq=2, book_ms=36_000_000, book_duration_ms=36_000_000)
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["book_ms"], 36_000_000)
        checkin(self.db, seq=3, book_ms=0, book_duration_ms=36_000_000)
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["book_ms"], 0)
        checkin(self.db, seq=4, book_ms=50_000_000)
        self.db.expire_all()
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["book_ms"], 36_000_000)

    def test_an_empty_chapter_name_is_stored_as_null(self):
        checkin(self.db, chapter_label="")
        self.assertIsNone(listening.get_position(self.db, ME, BOOK)["chapter_label"])
        self.assertIsNone(listening.get_history(self.db, ME, BOOK)[0]["chapter_label"])

    def test_book_ms_is_clamped_to_the_length_the_row_keeps(self):
        # T1R4: the album read failed (no length this time), so the row keeps
        # its length; the place is clamped to it in the UPDATE.
        from app.models import ListeningPosition
        checkin(self.db, book_ms=1_000, book_duration_ms=36_000_000, work_key=WORK_A)
        checkin(self.db, seq=2, book_ms=50_000_000)
        self.db.expire_all()
        row = self.db.query(ListeningPosition).one()
        self.assertEqual((row.book_ms, row.book_duration_ms), (36_000_000, 36_000_000))
        checkin(self.db, seq=3, book_ms=20_000_000)
        self.db.expire_all()
        self.assertEqual(self.db.query(ListeningPosition).one().book_ms, 20_000_000)
        # With no length anywhere there is nothing to clamp to.
        checkin(self.db, book="5002", psid="other", book_ms=50_000_000)
        self.assertEqual(listening.get_position(self.db, ME, "5002")["book_ms"], 50_000_000)

    def test_the_log_rows_are_clamped_the_same_way(self):
        # T1R7: the log row and a conflict's log row take the same clamp as
        # the position row when the check-in's length is unknown.
        checkin(self.db, book_ms=1_000, book_duration_ms=36_000_000, psid="p1")
        checkin(self.db, seq=2, book_ms=50_000_000, psid="p1")
        self.assertEqual([e["book_ms"] for e in listening.get_history(self.db, ME, BOOK)][0], 36_000_000)
        out = checkin(self.db, seq=1, book_ms=60_000_000, psid="p2")          # another page, no base
        self.assertIn("conflict", out)
        self.assertEqual([e["book_ms"] for e in listening.get_history(self.db, ME, BOOK)][0], 36_000_000)
        # Below the length, and a length carried this time, are as given.
        checkin(self.db, seq=3, book_ms=20_000_000, psid="p1")
        self.assertEqual(listening.get_history(self.db, ME, BOOK)[0]["book_ms"], 20_000_000)
        checkin(self.db, seq=4, book_ms=40_000_000, book_duration_ms=45_000_000, psid="p1")
        self.assertEqual(listening.get_history(self.db, ME, BOOK)[0]["book_ms"], 40_000_000)
        # No kept length: nothing to clamp to.
        checkin(self.db, book="5002", psid="p9", book_ms=50_000_000)
        self.assertEqual(listening.get_history(self.db, ME, "5002")[0]["book_ms"], 50_000_000)

    def test_a_checkin_without_the_players_fields_leaves_them_null(self):
        checkin(self.db, **self.FIELDS)
        checkin(self.db, seq=2)          # an older player: the place it saved carries none
        pos = listening.get_position(self.db, ME, BOOK)
        self.assertEqual((pos["book_ms"], pos["chapter_label"]), (None, None))

    def test_unknown_server_fields_keep_the_rows_values(self):
        # T1B3: a save whose album read failed carries None for the server's
        # three; the row keeps what it had rather than blanking it.
        from app.models import ListeningLog, ListeningPosition
        checkin(self.db, **self.FIELDS)
        checkin(self.db, seq=2, book_ms=5_000, chapter_label="Chapter 10")
        row = self.db.query(ListeningPosition).one()
        self.assertEqual((row.book_duration_ms, row.work_key, row.narrator), (36_000_000, WORK_A, "Tamsin Ashby"))
        self.assertEqual((row.book_ms, row.chapter_label), (5_000, "Chapter 10"))
        # The log row keeps what that check-in carried.
        last = self.db.query(ListeningLog).order_by(ListeningLog.id.desc()).first()
        self.assertEqual((last.work_key, last.narrator), (None, None))
        # Known values still replace them.
        checkin(self.db, seq=3, book_duration_ms=40_000_000, work_key=WORK_B, narrator="Dee Lane")
        self.db.expire_all()
        row = self.db.query(ListeningPosition).one()
        self.assertEqual((row.book_duration_ms, row.work_key, row.narrator), (40_000_000, WORK_B, "Dee Lane"))

    def test_the_book_title_is_kept_on_the_position_row_only(self):
        # Ruling (a): the title the library showed at check-in, so a place
        # offered from this copy can say which copy it was. Unknown leaves
        # the row's value; the log has no such column.
        from app.models import ListeningLog, ListeningPosition
        checkin(self.db, book_title="Tide Mill (Unabridged)")
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["book_title"], "Tide Mill (Unabridged)")
        checkin(self.db, seq=2, book_ms=5_000)
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["book_title"], "Tide Mill (Unabridged)")
        checkin(self.db, seq=3, book_title="Tide Mill")
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["book_title"], "Tide Mill")
        self.assertFalse(hasattr(ListeningLog, "book_title"))
        self.assertEqual(self.log_count(), 3)
        # Cut to its column, an empty one is unknown, and it must be text.
        checkin(self.db, seq=4, book_title="t" * 400)
        self.assertEqual(len(self.db.query(ListeningPosition).one().book_title), listening.BOOK_TITLE_MAX)
        checkin(self.db, seq=5, book_title="")
        self.db.expire_all()
        self.assertEqual(len(self.db.query(ListeningPosition).one().book_title), listening.BOOK_TITLE_MAX)
        with self.assertRaises(ValueError):
            checkin(self.db, seq=6, book_title=7)

    def test_a_conflict_logs_them_too(self):
        first = checkin(self.db, psid="desk")
        out = checkin(self.db, psid="phone", base="2020-01-01T00:00:00.000Z", **self.FIELDS)
        self.assertIn("conflict", out)
        self.assertEqual(listening.get_history(self.db, ME, BOOK)[0]["book_ms"], 4_000_000)
        self.assertEqual(listening.get_position(self.db, ME, BOOK)["updated_at"], first["updated_at"])

    def test_bad_values_are_refused(self):
        bad = [dict(book_ms=-1), dict(book_ms=10 ** 9 + 1), dict(book_ms=1.5), dict(book_ms="5"),
               dict(book_ms=True), dict(book_duration_ms=-1), dict(book_duration_ms=2.0),
               dict(chapter_label="x" * 201), dict(chapter_label=7), dict(work_key="xyz"),
               dict(work_key="A1" * 16), dict(work_key=WORK_A + "0"), dict(narrator=5)]
        for kw in bad:
            with self.subTest(kw):
                with self.assertRaises(ValueError):
                    checkin(self.db, **kw)
        self.assertIsNone(listening.get_position(self.db, ME, BOOK))
        self.assertEqual(self.log_count(), 0)
        # The largest taken, and a long narrator cut to its column.
        checkin(self.db, book_ms=10 ** 9, chapter_label="x" * 200, narrator="n" * 500)
        pos = listening.get_position(self.db, ME, BOOK)
        self.assertEqual((pos["book_ms"], len(pos["chapter_label"]), len(pos["narrator"])), (10 ** 9, 200, 200))


class FindLinked(StoreBase):
    """A book re-added as a new album finds this listener's place in its
    earlier copy by work key; the caller decides whether that copy is gone."""

    def save(self, book, identity=ME, work_key=WORK_A, **kw):
        return checkin(self.db, identity=identity, book=book, psid=f"p-{book}-{identity}", work_key=work_key, **kw)

    def test_the_newest_row_under_another_key(self):
        self.save("300:1", offset_ms=1)
        self.save("310:1", offset_ms=2)
        self.save("320:1", work_key=WORK_B)
        row = listening.find_linked(self.db, ME, WORK_A, "400:1")
        self.assertEqual((row.book_key, row.offset_ms), ("310:1", 2))
        # A copy the caller found still in the library is passed over.
        self.assertEqual(listening.find_linked(self.db, ME, WORK_A, "400:1", skip=["310:1"]).book_key, "300:1")
        self.assertIsNone(listening.find_linked(self.db, ME, WORK_A, "400:1", skip=["310:1", "300:1"]))

    def test_never_the_key_itself(self):
        self.save("400:1")
        self.assertIsNone(listening.find_linked(self.db, ME, WORK_A, "400:1"))

    def test_never_another_identitys_row(self):
        self.save("300:1", identity=THEM)
        self.assertIsNone(listening.find_linked(self.db, ME, WORK_A, "400:1"))
        self.assertEqual(listening.find_linked(self.db, THEM, WORK_A, "400:1").identity, THEM)

    def test_no_work_key_finds_nothing(self):
        self.save("300:1", work_key=None)
        for key in (None, "", "zz", WORK_A.upper()):
            with self.subTest(key=key):
                self.assertIsNone(listening.find_linked(self.db, ME, key, "400:1"))

    def test_the_lookup_uses_the_identity_work_key_index(self):
        from sqlalchemy import event
        self.save("300:1")
        engine = self.Session.kw["bind"]
        seen = []

        def capture(conn, cursor, statement, parameters, context, executemany):
            if "FROM listening_positions" in statement:
                seen.append((statement, parameters))
        event.listen(engine, "before_cursor_execute", capture)
        listening.find_linked(self.db, ME, WORK_A, "400:1", skip=["310:1"])
        listening.has_work_keys(self.db, ME, "400:1")
        event.remove(engine, "before_cursor_execute", capture)
        captured = list(seen)
        self.assertEqual(len(captured), 2)
        for statement, parameters in captured:
            with engine.connect() as conn:
                rows = conn.exec_driver_sql("EXPLAIN QUERY PLAN " + statement, tuple(parameters)).fetchall()
            plan = " ".join(str(r[-1]) for r in rows)
            self.assertIn("ix_listening_positions_identity_work_key", plan, statement)


class LinkedFrom(StoreBase):
    """The earlier copy a place was carried over from stays on the row, so
    its history stays with the book (the router verifies it first)."""

    def row(self, book="400:1"):
        from app.models import ListeningPosition
        row = self.db.query(ListeningPosition).filter_by(identity=ME, book_key=book).one()
        self.db.refresh(row)
        return row

    def test_set_once_and_kept_by_later_saves(self):
        checkin(self.db, book="400:1", seq=1)
        self.assertIsNone(self.row().linked_from)
        self.assertIs(listening.set_link(self.db, ME, "400:1", "300:1"), True)
        self.assertEqual(self.row().linked_from, "300:1")
        checkin(self.db, book="400:1", seq=2)
        self.assertEqual(self.row().linked_from, "300:1")
        # The same link again is still true; another one is refused.
        self.assertIs(listening.set_link(self.db, ME, "400:1", "300:1"), True)
        self.assertIs(listening.set_link(self.db, ME, "400:1", "310:1"), False)
        self.assertEqual(self.row().linked_from, "300:1")
        # Not part of the position the player reads (its linked_from means
        # "the files changed").
        self.assertNotIn("linked_from", listening.get_position(self.db, ME, "400:1"))

    def test_no_row_no_link(self):
        self.assertIsNone(listening.set_link(self.db, ME, "400:1", "300:1"))
        self.assertIsNone(listening.get_position(self.db, ME, "400:1"))

    def test_only_the_listeners_own_row(self):
        checkin(self.db, identity=THEM, book="400:1", psid="them")
        self.assertIsNone(listening.set_link(self.db, ME, "400:1", "300:1"))
        from app.models import ListeningPosition
        self.assertIsNone(self.db.query(ListeningPosition).filter_by(identity=THEM).one().linked_from)

    def test_a_bad_one_is_refused(self):
        checkin(self.db, book="400:1")
        for bad in ("", "junk", "300", "300:1:2", "400:1", 300, "a" * 70, None):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    listening.set_link(self.db, ME, "400:1", bad)
        self.assertIsNone(self.row().linked_from)

    def test_the_chain_follows_each_copys_own_link(self):
        # T1S4: A became B became C: C's history reaches A through B.
        for book, link in (("100:1", None), ("200:1", "100:1"), ("300:1", "200:1")):
            checkin(self.db, book=book, psid="p-" + book)
            if link:
                listening.set_link(self.db, ME, book, link)
        self.assertEqual(listening.link_chain(self.db, ME, "300:1", "200:1"), ["200:1", "100:1"])
        self.assertEqual(listening.link_chain(self.db, ME, "300:1", None), [])
        # Another listener's rows are never followed.
        self.assertEqual(listening.link_chain(self.db, THEM, "300:1", "200:1"), ["200:1"])

    def test_the_chain_stops_at_a_loop_and_after_five(self):
        checkin(self.db, book="1:1", psid="a")
        checkin(self.db, book="2:1", psid="b")
        listening.set_link(self.db, ME, "1:1", "2:1")
        listening.set_link(self.db, ME, "2:1", "1:1")
        self.assertEqual(listening.link_chain(self.db, ME, "9:1", "1:1"), ["1:1", "2:1"])
        self.assertEqual(listening.link_chain(self.db, ME, "1:1", "2:1"), ["2:1"])
        for n in range(10, 20):
            checkin(self.db, book=f"{n}:1", psid=f"p{n}")
            listening.set_link(self.db, ME, f"{n}:1", f"{n + 1}:1")
        self.assertEqual(listening.link_chain(self.db, ME, "9:1", "10:1"), ["10:1", "11:1", "12:1", "13:1", "14:1"])
        self.assertEqual(listening.LINK_HOPS, 5)

    def test_successors_are_the_listeners_rows_that_carried_a_copy_forward(self):
        # T5F1: the copies whose linked_from is the key, newest first, never
        # one excluded, never another listener's, at most LINK_TRIES.
        import time
        self.assertEqual(listening.successors(self.db, ME, "300:1"), [])
        for book in ("400:1", "410:1", "420:1", "430:1"):
            checkin(self.db, book=book, psid="p-" + book)
            listening.set_link(self.db, ME, book, "300:1")
            time.sleep(0.002)
        checkin(self.db, identity=THEM, book="440:1", psid="them")
        listening.set_link(self.db, THEM, "440:1", "300:1")
        checkin(self.db, book="450:1", psid="p-450")
        listening.set_link(self.db, ME, "450:1", "310:1")
        self.assertEqual(listening.successors(self.db, ME, "300:1"), ["430:1", "420:1", "410:1"])
        self.assertEqual(listening.successors(self.db, ME, "300:1", exclude=["430:1", "410:1", None]),
                         ["420:1", "400:1"])
        self.assertEqual(listening.successors(self.db, THEM, "300:1"), ["440:1"])
        self.assertEqual(listening.successors(self.db, ME, None), [])
        self.assertEqual(listening.LINK_TRIES, 3)

    def test_the_successor_read_is_scoped_by_an_identity_index(self):
        from sqlalchemy import event
        checkin(self.db, book="400:1")
        listening.set_link(self.db, ME, "400:1", "300:1")
        engine = self.Session.kw["bind"]
        seen = []

        def capture(conn, cursor, statement, parameters, context, executemany):
            if "FROM listening_positions" in statement:
                seen.append((statement, parameters))
        event.listen(engine, "before_cursor_execute", capture)
        listening.successors(self.db, ME, "300:1", exclude=["410:1"])
        event.remove(engine, "before_cursor_execute", capture)
        self.assertEqual(len(seen), 1)
        statement, parameters = seen[0]
        with engine.connect() as conn:
            rows = conn.exec_driver_sql("EXPLAIN QUERY PLAN " + statement, tuple(parameters)).fetchall()
        plan = " ".join(str(r[-1]) for r in rows)
        self.assertIn("USING INDEX", plan)
        self.assertIn("identity=?", plan)

    def test_has_work_keys_is_the_listeners_own_under_another_key(self):
        self.assertFalse(listening.has_work_keys(self.db, ME, "400:1"))
        checkin(self.db, book="300:1", work_key=None)
        self.assertFalse(listening.has_work_keys(self.db, ME, "400:1"))
        checkin(self.db, identity=THEM, book="310:1", psid="them", work_key=WORK_A)
        self.assertFalse(listening.has_work_keys(self.db, ME, "400:1"))
        checkin(self.db, book="400:1", psid="new", work_key=WORK_A)
        self.assertFalse(listening.has_work_keys(self.db, ME, "400:1"))
        checkin(self.db, book="320:1", psid="other", work_key=WORK_B)
        self.assertTrue(listening.has_work_keys(self.db, ME, "400:1"))


class EarlierCopyHistory(StoreBase):
    def test_linked_rows_are_merged_and_marked(self):
        checkin(self.db, book="300:1", offset_ms=1, psid="old", seq=1)
        checkin(self.db, book="300:1", offset_ms=2, psid="old", seq=2)
        checkin(self.db, identity=THEM, book="300:1", offset_ms=99, psid="them")
        checkin(self.db, book="400:1", offset_ms=3, psid="new", seq=1)
        page = listening.get_history_page(self.db, ME, "400:1", linked="300:1")
        self.assertEqual([(e["offset_ms"], e["book_key"], e.get("earlier_copy")) for e in page["entries"]],
                         [(3, "400:1", None), (2, "300:1", True), (1, "300:1", True)])
        # Paged one at a time, each row once.
        got, before = [], None
        while True:
            page = listening.get_history_page(self.db, ME, "400:1", limit=1, before=before, linked="300:1")
            got += [e["offset_ms"] for e in page["entries"]]
            before = page["next_before"]
            if before is None:
                break
        self.assertEqual(got, [3, 2, 1])
        # A list of earlier copies (a chain): every one of them, marked.
        checkin(self.db, book="290:1", offset_ms=0, psid="oldest")
        page = listening.get_history_page(self.db, ME, "400:1", linked=["300:1", "290:1", "400:1"])
        self.assertEqual([(e["offset_ms"], e.get("earlier_copy")) for e in page["entries"]],
                         [(0, True), (3, None), (2, True), (1, True)])
        # Without a link, only the book's own rows.
        self.assertEqual([e["offset_ms"] for e in listening.get_history_page(self.db, ME, "400:1")["entries"]], [3])


class Claims(StoreBase):
    """Spec 2.6 s4: one successor per earlier copy. A check-in that carries
    linked_from claims that copy for its book, verified or pending; SQLite's
    own key on (identity, earlier copy) lets only one book hold it."""

    def claims(self, identity=ME):
        from app.models import ListeningClaim
        self.db.expire_all()
        return {(c.earlier_key, c.holder_key, c.state)
                for c in self.db.query(ListeningClaim).filter_by(identity=identity)}

    def link_of(self, book, identity=ME):
        from app.models import ListeningPosition
        self.db.expire_all()
        return self.db.query(ListeningPosition).filter_by(identity=identity, book_key=book).one().linked_from

    def test_sqlite_itself_refuses_a_second_claim_on_one_earlier_copy(self):
        from sqlalchemy.exc import IntegrityError
        from app.models import ListeningClaim
        at = datetime(2026, 10, 1)
        self.db.add(ListeningClaim(identity=ME, earlier_key="300:1", holder_key="400:1", state="verified",
                                   claimed_at=at))
        self.db.commit()
        self.db.add(ListeningClaim(identity=ME, earlier_key="300:1", holder_key="410:1", state="pending",
                                   claimed_at=at))
        with self.assertRaises(IntegrityError):
            self.db.commit()
        self.db.rollback()
        # Another listener's claim on the same key is theirs alone.
        self.db.add(ListeningClaim(identity=THEM, earlier_key="300:1", holder_key="410:1", state="pending",
                                   claimed_at=at))
        self.db.commit()
        self.assertEqual(self.claims(), {("300:1", "400:1", "verified")})
        self.assertEqual(self.claims(THEM), {("300:1", "410:1", "pending")})

    def test_pending_then_verified(self):
        checkin(self.db, book="400:1")
        self.assertIsNone(listening.claim_link(self.db, ME, "400:1", "300:1", None))
        self.assertEqual(self.claims(), {("300:1", "400:1", "pending")})
        self.assertIsNone(self.link_of("400:1"))          # the row's link waits for the verify
        self.assertIsNone(listening.claim_link(self.db, ME, "400:1", "300:1", None))   # a resend, still unsure
        self.assertIs(listening.claim_link(self.db, ME, "400:1", "300:1", True), True)
        self.assertEqual(self.claims(), {("300:1", "400:1", "verified")})
        self.assertEqual(self.link_of("400:1"), "300:1")
        # Held and linked: an unsure resend still says so.
        self.assertIs(listening.claim_link(self.db, ME, "400:1", "300:1", None), True)

    def test_a_refusal_drops_a_pending_claim_but_never_a_verified_one(self):
        checkin(self.db, book="400:1")
        listening.claim_link(self.db, ME, "400:1", "300:1", None)
        self.assertIs(listening.claim_link(self.db, ME, "400:1", "300:1", False), False)
        self.assertEqual(self.claims(), set())
        listening.claim_link(self.db, ME, "400:1", "300:1", True)
        self.assertIs(listening.claim_link(self.db, ME, "400:1", "300:1", False), False)
        self.assertEqual(self.claims(), {("300:1", "400:1", "verified")})
        self.assertEqual(self.link_of("400:1"), "300:1")

    def test_another_copys_claim_names_its_holder(self):
        checkin(self.db, book="400:1", psid="b")
        checkin(self.db, book="410:1", psid="c")
        listening.claim_link(self.db, ME, "400:1", "300:1", None)
        for verdict in (True, None):
            with self.subTest(verdict=verdict):
                self.assertEqual(listening.claim_link(self.db, ME, "410:1", "300:1", verdict), "400:1")
        self.assertEqual(self.claims(), {("300:1", "400:1", "pending")})
        self.assertIsNone(self.link_of("410:1"))
        # Released by name (its holder's album is gone): the claim moves.
        self.assertIs(listening.claim_link(self.db, ME, "410:1", "300:1", True, release="400:1"), True)
        self.assertEqual(self.claims(), {("300:1", "410:1", "verified")})
        self.assertEqual(self.link_of("410:1"), "300:1")

    def test_a_holder_whose_row_was_deleted_or_reset_holds_nothing(self):
        from app.models import ListeningPosition
        checkin(self.db, book="400:1", psid="b")
        checkin(self.db, book="410:1", psid="c")
        checkin(self.db, book="420:1", psid="d")
        listening.claim_link(self.db, ME, "400:1", "300:1", True)
        listening.claim_link(self.db, ME, "410:1", "310:1", None)
        self.assertEqual(listening.successors(self.db, ME, "300:1"), ["400:1"])
        self.assertEqual(listening.successors(self.db, ME, "310:1"), ["410:1"])
        # 400:1's row is reset (its link cleared); 410:1's row is deleted.
        self.db.query(ListeningPosition).filter_by(identity=ME, book_key="400:1").update({"linked_from": None})
        self.db.query(ListeningPosition).filter_by(identity=ME, book_key="410:1").delete()
        self.db.commit()
        self.assertEqual(listening.successors(self.db, ME, "300:1"), [])
        self.assertEqual(listening.successors(self.db, ME, "310:1"), [])
        self.assertIs(listening.claim_link(self.db, ME, "420:1", "300:1", True), True)
        self.assertIs(listening.claim_link(self.db, ME, "400:1", "310:1", None), None)
        self.assertEqual(self.claims(), {("300:1", "420:1", "verified"), ("310:1", "400:1", "pending")})

    def test_no_row_no_claim_and_a_row_with_another_link_none(self):
        self.assertIsNone(listening.claim_link(self.db, ME, "400:1", "300:1", True))
        self.assertEqual(self.claims(), set())
        checkin(self.db, book="400:1")
        listening.claim_link(self.db, ME, "400:1", "300:1", True)
        for verdict in (True, None):
            with self.subTest(verdict=verdict):
                self.assertIs(listening.claim_link(self.db, ME, "400:1", "310:1", verdict), False)
        self.assertEqual(self.claims(), {("300:1", "400:1", "verified")})
        for bad in ("", "junk", "300", "400:1", None, 300):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    listening.claim_link(self.db, ME, "400:1", bad, True)

    def test_successors_count_a_pending_claim_like_a_link(self):
        import time
        checkin(self.db, book="400:1", psid="b")
        time.sleep(0.002)
        checkin(self.db, book="410:1", psid="c")
        listening.set_link(self.db, ME, "400:1", "300:1")
        listening.claim_link(self.db, ME, "410:1", "310:1", None)
        self.assertEqual(listening.successors(self.db, ME, "310:1"), ["410:1"])
        self.assertEqual(listening.successors(self.db, ME, "310:1", exclude=["410:1"]), [])
        self.assertEqual(listening.successors(self.db, ME, "300:1"), ["400:1"])
        self.assertEqual(listening.successors(self.db, THEM, "310:1"), [])

    def test_pending_claim_is_the_books_own_pending_claim_only(self):
        checkin(self.db, book="400:1", psid="b")
        checkin(self.db, book="410:1", psid="c")
        checkin(self.db, identity=THEM, book="400:1", psid="them")
        self.assertIsNone(listening.pending_claim(self.db, ME, "400:1"))
        listening.claim_link(self.db, ME, "400:1", "300:1", None)
        listening.claim_link(self.db, THEM, "400:1", "310:1", None)
        self.assertEqual(listening.pending_claim(self.db, ME, "400:1"), "300:1")
        self.assertIsNone(listening.pending_claim(self.db, ME, "410:1"))        # another book's
        self.assertEqual(listening.pending_claim(self.db, THEM, "400:1"), "310:1")
        listening.claim_link(self.db, ME, "400:1", "300:1", True)
        self.assertIsNone(listening.pending_claim(self.db, ME, "400:1"))        # verified now

    def test_pending_claim_ignores_a_claim_whose_row_is_gone(self):
        from app.models import ListeningPosition
        checkin(self.db, book="400:1", psid="b")
        listening.claim_link(self.db, ME, "400:1", "300:1", None)
        self.db.query(ListeningPosition).filter_by(identity=ME, book_key="400:1").delete()
        self.db.commit()
        self.assertIsNone(listening.pending_claim(self.db, ME, "400:1"))

    def test_another_listeners_pending_claim_is_not_my_successor(self):
        # THEM holds a pending claim on 300:1 through 410:1; ME has an
        # unlinked row on the same book key. ME's lookup must not see it.
        checkin(self.db, identity=THEM, book="410:1", psid="t")
        listening.claim_link(self.db, THEM, "410:1", "300:1", None)
        checkin(self.db, identity=ME, book="410:1", psid="m")
        self.assertEqual(listening.successors(self.db, ME, "300:1"), [])
        self.assertEqual(listening.successors(self.db, THEM, "300:1"), ["410:1"])

    def test_another_listeners_row_does_not_keep_my_released_claim_alive(self):
        # ME claimed 300:1 through 400:1 and then lost that row; THEM still
        # has a row on 400:1. The claim is ME's alone to lose, so another of
        # ME's books can take it.
        from app.models import ListeningPosition
        checkin(self.db, identity=ME, book="400:1", psid="m")
        checkin(self.db, identity=ME, book="420:1", psid="m2")
        checkin(self.db, identity=THEM, book="400:1", psid="t")
        self.assertIs(listening.claim_link(self.db, ME, "400:1", "300:1", True), True)
        self.assertIs(listening.claim_link(self.db, THEM, "400:1", "300:1", True), True)
        self.db.query(ListeningPosition).filter_by(identity=ME, book_key="400:1").delete()
        self.db.commit()
        self.assertIs(listening.claim_link(self.db, ME, "420:1", "300:1", True), True)
        self.assertEqual(self.claims(), {("300:1", "420:1", "verified")})
        self.assertEqual(self.claims(THEM), {("300:1", "400:1", "verified")})

    def test_identities_are_isolated(self):
        checkin(self.db, book="400:1", psid="b")
        checkin(self.db, identity=THEM, book="410:1", psid="them")
        listening.claim_link(self.db, THEM, "410:1", "300:1", None)
        self.assertIs(listening.claim_link(self.db, ME, "400:1", "300:1", True), True)
        self.assertEqual(self.claims(), {("300:1", "400:1", "verified")})
        self.assertEqual(self.claims(THEM), {("300:1", "410:1", "pending")})
        self.assertEqual(listening.successors(self.db, THEM, "300:1"), ["410:1"])
        self.assertEqual(listening.successors(self.db, ME, "300:1"), ["400:1"])

    def test_a_checkin_writes_its_claim_in_the_saves_own_transaction(self):
        from sqlalchemy import event
        engine = self.Session.kw["bind"]
        seen = []

        def statement(conn, cursor, sql, parameters, context, executemany):
            if sql.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE")):
                seen.append(sql.split("(")[0].strip())

        def commit(conn):
            seen.append("COMMIT")
        for kind in ("stored", "older seq", "conflict"):
            with self.subTest(kind=kind):
                book = {"stored": "400:1", "older seq": "410:1", "conflict": "420:1"}[kind]
                if kind == "older seq":
                    checkin(self.db, book=book, psid="p", seq=5)
                if kind == "conflict":
                    checkin(self.db, book=book, psid="another device", seq=1)
                listening.prune_if_due(self.db)          # not due again: no housekeeping write below
                seen.clear()
                event.listen(engine, "before_cursor_execute", statement)
                event.listen(engine, "commit", commit)
                try:
                    result = checkin(self.db, book=book, psid="p", seq=1, link=(f"3{book[1:]}", None))
                finally:
                    event.remove(engine, "before_cursor_execute", statement)
                    event.remove(engine, "commit", commit)
                self.assertIsNone(result["link"])
                self.assertEqual(seen.count("COMMIT"), 1, seen)
                self.assertTrue(any(s.startswith("INSERT INTO listening_claims") or
                                    s.startswith("INSERT OR IGNORE INTO listening_claims") for s in seen), seen)
                self.assertEqual(self.claims() & {(f"3{book[1:]}", book, "pending")},
                                 {(f"3{book[1:]}", book, "pending")})
        # And a verified link is kept on the row in that same transaction.
        result = checkin(self.db, book="430:1", psid="p", link=("330:1", True))
        self.assertIs(result["link"], True)
        self.assertEqual(self.link_of("430:1"), "330:1")
        self.assertNotIn("link", checkin(self.db, book="440:1", psid="p"))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class BookFieldsMigration(unittest.TestCase):
    """An install from before spec 2.5 gets the five columns on both tables
    and the (identity, work_key) index, once, with its rows kept (nulls),
    and two workers starting at once both come up."""

    NEW = ("book_ms", "book_duration_ms", "chapter_label", "work_key", "narrator")

    def old_file_db(self):
        import os
        import tempfile
        from sqlalchemy import create_engine, text
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.addCleanup(os.remove, path)
        engine = create_engine("sqlite:///" + path)
        self.addCleanup(engine.dispose)
        with engine.begin() as conn:
            conn.execute(text(
                "CREATE TABLE listening_positions (identity VARCHAR(255) NOT NULL, book_key VARCHAR(64) NOT NULL, "
                "track_key VARCHAR(64) NOT NULL, offset_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL, "
                "updated_at DATETIME NOT NULL, device VARCHAR(80) NOT NULL, device_id VARCHAR(40), "
                "source VARCHAR(10) NOT NULL, psid VARCHAR(64), seq INTEGER, PRIMARY KEY (identity, book_key))"))
            conn.execute(text(
                "CREATE TABLE listening_log (id INTEGER PRIMARY KEY, identity VARCHAR(255) NOT NULL, "
                "book_key VARCHAR(64) NOT NULL, track_key VARCHAR(64) NOT NULL, offset_ms INTEGER NOT NULL, "
                "device VARCHAR(80) NOT NULL, device_id VARCHAR(40), event VARCHAR(16) NOT NULL, "
                "at DATETIME NOT NULL)"))
            conn.execute(text(
                "INSERT INTO listening_positions VALUES ('plex:1', '5:1', '6', 10, 20, '2026-09-01 00:00:00', "
                "'Chrome on Linux', NULL, 'web', 'p', 1)"))
            conn.execute(text(
                "INSERT INTO listening_log (identity, book_key, track_key, offset_ms, device, event, at) "
                "VALUES ('plex:1', '5:1', '6', 10, 'Chrome on Linux', 'pause', '2026-09-01 00:00:00')"))
        return engine

    @staticmethod
    def columns(db, table):
        from sqlalchemy import text
        return {row[1] for row in db.execute(text(f"PRAGMA table_info({table})"))}

    @staticmethod
    def indexes(db):
        from sqlalchemy import text
        return {row[1] for row in db.execute(text("PRAGMA index_list(listening_positions)"))}

    def test_adds_the_columns_and_index_once_and_keeps_the_rows(self):
        import logging
        from sqlalchemy import text
        from sqlalchemy.orm import sessionmaker
        from app.seed import migrate_listening_book_fields
        db = sessionmaker(bind=self.old_file_db())()
        try:
            with self.assertLogs("app.seed", level=logging.INFO):
                migrate_listening_book_fields(db)
            with self.assertNoLogs("app.seed", level=logging.INFO):
                migrate_listening_book_fields(db)   # idempotent: nothing left to do
            for table in ("listening_positions", "listening_log"):
                self.assertTrue(set(self.NEW) <= self.columns(db, table), table)
            for column in ("linked_from", "book_title"):
                self.assertIn(column, self.columns(db, "listening_positions"))
                self.assertNotIn(column, self.columns(db, "listening_log"))
            self.assertIn("ix_listening_positions_identity_work_key", self.indexes(db))
            self.assertEqual(tuple(db.execute(text(
                "SELECT offset_ms, book_ms, book_duration_ms, chapter_label, work_key, narrator, linked_from, "
                "book_title FROM listening_positions")).one()), (10, None, None, None, None, None, None, None))
            self.assertEqual(tuple(db.execute(text("SELECT event, book_ms, work_key FROM listening_log")).one()),
                             ("pause", None, None))
            # The store works on the upgraded tables: the old row reads with
            # nulls, and a new save and a lookup work.
            pos = listening.get_position(db, "plex:1", "5:1")
            self.assertEqual((pos["offset_ms"], pos["book_ms"], pos["narrator"]), (10, None, None))
            checkin(db, identity="plex:1", book="7:1", work_key=WORK_A, book_ms=5, book_duration_ms=9)
            self.assertEqual(listening.find_linked(db, "plex:1", WORK_A, "8:1").book_key, "7:1")
        finally:
            db.close()

    def test_an_install_with_the_other_columns_gains_book_title(self):
        # Dev and anything installed before fix round 5: every other book
        # column is there already, only book_title is added, rows kept.
        import logging
        from sqlalchemy import text
        from sqlalchemy.orm import sessionmaker
        from app.seed import migrate_listening_book_fields
        engine = self.old_file_db()
        with engine.begin() as conn:
            for name, kind in (("book_ms", "INTEGER"), ("book_duration_ms", "INTEGER"),
                               ("chapter_label", "VARCHAR(200)"), ("work_key", "VARCHAR(32)"),
                               ("narrator", "VARCHAR(200)")):
                conn.execute(text(f"ALTER TABLE listening_positions ADD COLUMN {name} {kind}"))
                conn.execute(text(f"ALTER TABLE listening_log ADD COLUMN {name} {kind}"))
            conn.execute(text("ALTER TABLE listening_positions ADD COLUMN linked_from VARCHAR(64)"))
        db = sessionmaker(bind=engine)()
        try:
            self.assertNotIn("book_title", self.columns(db, "listening_positions"))
            with self.assertLogs("app.seed", level=logging.INFO) as logs:
                migrate_listening_book_fields(db)
            self.assertEqual([r.getMessage() for r in logs.records], ["Added listening_positions.book_title"])
            self.assertIn("book_title", self.columns(db, "listening_positions"))
            self.assertEqual(tuple(db.execute(text("SELECT offset_ms, book_title FROM listening_positions")).one()),
                             (10, None))
        finally:
            db.close()

    def test_two_workers_at_once_both_come_up(self):
        # Worker 2 runs the whole migration between worker 1's look at the
        # table and its first ALTER: worker 1 meets "duplicate column" on
        # every column it still thought missing, and carries on.
        from sqlalchemy import create_engine, event
        from sqlalchemy.orm import sessionmaker
        from app.seed import migrate_listening_book_fields
        engine = self.old_file_db()
        other = create_engine(str(engine.url))
        self.addCleanup(other.dispose)
        raced = []

        def other_worker(conn, cursor, statement, parameters, context, executemany):
            if statement.startswith("ALTER TABLE") and not raced:
                raced.append(statement)
                db2 = sessionmaker(bind=other)()
                try:
                    migrate_listening_book_fields(db2)
                finally:
                    db2.close()
        event.listen(engine, "before_cursor_execute", other_worker)
        self.addCleanup(event.remove, engine, "before_cursor_execute", other_worker)
        db = sessionmaker(bind=engine)()
        try:
            migrate_listening_book_fields(db)
            self.assertEqual(len(raced), 1)
            for table in ("listening_positions", "listening_log"):
                self.assertTrue(set(self.NEW) <= self.columns(db, table), table)
            self.assertIn("linked_from", self.columns(db, "listening_positions"))
            self.assertIn("book_title", self.columns(db, "listening_positions"))
            self.assertIn("ix_listening_positions_identity_work_key", self.indexes(db))
        finally:
            db.close()

    def test_no_op_on_a_fresh_schema_and_before_the_tables_exist(self):
        import logging
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from app.seed import migrate_listening_book_fields
        db = helpers.make_sessionmaker()()
        try:
            with self.assertNoLogs("app.seed", level=logging.INFO):
                migrate_listening_book_fields(db)
            self.assertIn("ix_listening_positions_identity_work_key", self.indexes(db))
        finally:
            db.close()
        empty = sessionmaker(bind=create_engine("sqlite://"))()
        try:
            migrate_listening_book_fields(empty)     # no tables yet: create_all makes them
            self.assertEqual(self.columns(empty, "listening_log"), set())
        finally:
            empty.close()

    def test_init_db_runs_it_after_the_device_id_columns(self):
        import inspect as pyinspect
        from app import database
        source = pyinspect.getsource(database.init_db)
        self.assertIn("migrate_listening_book_fields(db)", source)
        self.assertLess(source.index("migrate_listening_device_id(db)"),
                        source.index("migrate_listening_book_fields(db)"))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ClaimsBackfill(unittest.TestCase):
    """Spec 2.6 s4: an install from before claims gets one for every link
    its rows already hold, once. Where two rows hold the same earlier copy
    (the race this closes), the newer one gets it. Two workers starting at
    once both come up."""

    def file_db(self):
        import os
        import tempfile
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from app import models  # noqa: F401  registers the tables
        from app.database import Base
        from app.models import ListeningPosition
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.addCleanup(os.remove, path)
        engine = create_engine("sqlite:///" + path)
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(bind=engine)
        db = sessionmaker(bind=engine)()
        for identity, book, link, day in ((ME, "400:1", "300:1", 20), (ME, "410:1", "300:1", 25),
                                          (ME, "420:1", "400:1", 26), (ME, "430:1", None, 27),
                                          (THEM, "400:1", "300:1", 21)):
            db.add(ListeningPosition(identity=identity, book_key=book, track_key="1", offset_ms=5, duration_ms=9,
                                     updated_at=datetime(2026, 9, day), device="Phone", source="web",
                                     linked_from=link))
        db.commit()
        db.close()
        return engine

    @staticmethod
    def claims(db):
        from sqlalchemy import text
        return set(map(tuple, db.execute(text(
            "SELECT identity, earlier_key, holder_key, state FROM listening_claims")).fetchall()))

    EXPECTED = {(ME, "300:1", "410:1", "verified"), (ME, "400:1", "420:1", "verified"),
                (THEM, "300:1", "400:1", "verified")}

    def test_every_link_gets_its_claim_once(self):
        import logging
        from sqlalchemy.orm import sessionmaker
        from app.seed import migrate_listening_claims
        db = sessionmaker(bind=self.file_db())()
        try:
            with self.assertLogs("app.seed", level=logging.INFO):
                migrate_listening_claims(db)
            self.assertEqual(self.claims(db), self.EXPECTED)
            with self.assertNoLogs("app.seed", level=logging.INFO):
                migrate_listening_claims(db)       # once: nothing left to do
            self.assertEqual(self.claims(db), self.EXPECTED)
            # The store reads them: 300:1's place lives on in 410:1 (and in
            # 400:1, which still holds the link for its history).
            self.assertEqual(listening.successors(db, ME, "300:1"), ["410:1", "400:1"])
        finally:
            db.close()

    def test_two_workers_at_once_both_come_up(self):
        # Worker 2 runs the whole migration between worker 1's look for the
        # marker and its back-fill: worker 1 writes nothing twice and carries on.
        from sqlalchemy import create_engine, event
        from sqlalchemy.orm import sessionmaker
        from app.seed import migrate_listening_claims
        engine = self.file_db()
        other = create_engine(str(engine.url))
        self.addCleanup(other.dispose)
        raced = []

        def other_worker(conn, cursor, statement, parameters, context, executemany):
            if "INTO listening_claims" in statement and not raced:
                raced.append(statement)
                db2 = sessionmaker(bind=other)()
                try:
                    migrate_listening_claims(db2)
                finally:
                    db2.close()
        event.listen(engine, "before_cursor_execute", other_worker)
        self.addCleanup(event.remove, engine, "before_cursor_execute", other_worker)
        db = sessionmaker(bind=engine)()
        try:
            migrate_listening_claims(db)
            self.assertEqual(len(raced), 1)
            self.assertEqual(self.claims(db), self.EXPECTED)
        finally:
            db.close()

    def test_no_op_before_the_tables_exist(self):
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from app.seed import migrate_listening_claims
        empty = sessionmaker(bind=create_engine("sqlite://"))()
        try:
            migrate_listening_claims(empty)     # no tables yet: create_all makes them
        finally:
            empty.close()

    def run_init_db(self, engine):
        from sqlalchemy.orm import sessionmaker
        from app import database
        with mock.patch.object(database, "engine", engine), \
                mock.patch.object(database, "SessionLocal", sessionmaker(bind=engine)):
            database.init_db()

    def test_init_db_gives_a_pre_claims_database_its_claims(self):
        # A real database from before 2.6: the links are there, the claims
        # table is not. Starting the app fills it (and only once).
        from sqlalchemy.orm import sessionmaker
        from app.models import ListeningClaim
        engine = self.file_db()
        ListeningClaim.__table__.drop(engine)
        self.run_init_db(engine)
        db = sessionmaker(bind=engine)()
        try:
            self.assertEqual(self.claims(db), self.EXPECTED)
            self.run_init_db(engine)                    # the next start: nothing more to do
            self.assertEqual(self.claims(db), self.EXPECTED)
        finally:
            db.close()

    def test_init_db_runs_it_after_the_book_fields_exist(self):
        # An install from before 2.5 has no linked_from column yet: the claims
        # back-fill reads it, so it must come after the migration that adds it.
        from sqlalchemy import text
        from sqlalchemy.orm import sessionmaker
        engine = DeviceIdMigration.old_schema(self).get_bind()
        self.run_init_db(engine)
        db = sessionmaker(bind=engine)()
        try:
            self.assertEqual(self.claims(db), set())
            self.assertEqual(db.execute(text("SELECT count(*) FROM listening_positions")).scalar(), 1)
        finally:
            db.close()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class DeviceIdMigration(unittest.TestCase):
    """An install from before device ids gets the columns added, once, with
    its rows kept (and a null id)."""

    def old_schema(self):
        from sqlalchemy import create_engine, text
        from sqlalchemy.orm import sessionmaker
        from sqlalchemy.pool import StaticPool
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        with engine.begin() as conn:
            conn.execute(text(
                "CREATE TABLE listening_positions (identity VARCHAR(255) NOT NULL, book_key VARCHAR(64) NOT NULL, "
                "track_key VARCHAR(64) NOT NULL, offset_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL, "
                "updated_at DATETIME NOT NULL, device VARCHAR(80) NOT NULL, source VARCHAR(10) NOT NULL, "
                "psid VARCHAR(64), seq INTEGER, PRIMARY KEY (identity, book_key))"))
            conn.execute(text(
                "CREATE TABLE listening_log (id INTEGER PRIMARY KEY, identity VARCHAR(255) NOT NULL, "
                "book_key VARCHAR(64) NOT NULL, track_key VARCHAR(64) NOT NULL, offset_ms INTEGER NOT NULL, "
                "device VARCHAR(80) NOT NULL, event VARCHAR(16) NOT NULL, at DATETIME NOT NULL)"))
            conn.execute(text(
                "INSERT INTO listening_positions VALUES ('plex:1', '5:1', '6', 10, 20, '2026-09-01 00:00:00', "
                "'Chrome on Linux', 'web', 'p', 1)"))
            conn.execute(text(
                "INSERT INTO listening_log (identity, book_key, track_key, offset_ms, device, event, at) "
                "VALUES ('plex:1', '5:1', '6', 10, 'Chrome on Linux', 'pause', '2026-09-01 00:00:00')"))
        return sessionmaker(bind=engine)()

    @staticmethod
    def columns(db, table):
        from sqlalchemy import text
        return {row[1] for row in db.execute(text(f"PRAGMA table_info({table})"))}

    def test_adds_the_columns_once_and_keeps_the_rows(self):
        import logging
        from sqlalchemy import text
        from app.seed import migrate_listening_device_id
        db = self.old_schema()
        try:
            with self.assertLogs("app.seed", level=logging.INFO):
                migrate_listening_device_id(db)
            with self.assertNoLogs("app.seed", level=logging.INFO):
                migrate_listening_device_id(db)   # idempotent: nothing left to do
            self.assertIn("device_id", self.columns(db, "listening_positions"))
            self.assertIn("device_id", self.columns(db, "listening_log"))
            self.assertEqual(tuple(db.execute(text("SELECT offset_ms, device_id FROM listening_positions")).one()),
                             (10, None))
            self.assertEqual(tuple(db.execute(text("SELECT event, device_id FROM listening_log")).one()),
                             ("pause", None))
            # The store works on the upgraded tables (once the later
            # migration init_db also runs has added the book-time columns).
            from app.seed import migrate_listening_book_fields
            migrate_listening_book_fields(db)
            self.assertEqual(listening.get_position(db, "plex:1", "5:1")["device_id"], None)
        finally:
            db.close()

    def test_no_op_on_a_fresh_schema_and_before_the_tables_exist(self):
        import logging
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from app.seed import migrate_listening_device_id
        db = helpers.make_sessionmaker()()
        try:
            with self.assertNoLogs("app.seed", level=logging.INFO):
                migrate_listening_device_id(db)
            self.assertIn("device_id", self.columns(db, "listening_log"))
        finally:
            db.close()
        empty = sessionmaker(bind=create_engine("sqlite://"))()
        try:
            migrate_listening_device_id(empty)     # no tables yet: create_all makes them
            self.assertEqual(self.columns(empty, "listening_log"), set())
        finally:
            empty.close()

    def test_init_db_runs_it(self):
        import inspect as pyinspect
        from app import database
        self.assertIn("migrate_listening_device_id(db)", pyinspect.getsource(database.init_db))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class StartupTables(unittest.TestCase):
    """The two uvicorn workers both create the missing tables at startup (the
    player's three on an upgrade). The one that loses the race gets SQLite's
    "table ... already exists"; it tries once more rather than dying, since a
    worker that raises at startup is never restarted."""

    NEW = ("listening_positions", "listening_log", "player_prefs")

    def upgrade_db(self):
        import os
        import tempfile
        from sqlalchemy import create_engine
        from app.database import Base
        from app import models  # noqa: F401  registers the tables
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.addCleanup(os.remove, path)
        engine = create_engine("sqlite:///" + path)
        self.addCleanup(engine.dispose)
        # An install from before the player: every table but its three.
        Base.metadata.create_all(bind=engine, tables=[t for n, t in Base.metadata.tables.items() if n not in self.NEW])
        return engine, Base

    def test_the_worker_that_loses_the_race_tries_again(self):
        from sqlalchemy import event, text
        from app.database import create_tables
        engine, Base = self.upgrade_db()
        raced = []

        # The other worker creates each table between this one's check and its
        # CREATE: first one table, then (on the retry) the next.
        def other_worker(target, connection, **kw):
            if target.name in raced:
                return
            raced.append(target.name)
            with engine.connect() as other:
                other.execute(text(f"CREATE TABLE {target.name} (id INTEGER PRIMARY KEY)"))
                other.commit()

        for name in ("listening_log", "player_prefs"):
            table = Base.metadata.tables[name]
            event.listen(table, "before_create", other_worker)
            self.addCleanup(event.remove, table, "before_create", other_worker)
        create_tables(engine)
        self.assertEqual(sorted(raced), ["listening_log", "player_prefs"])
        with engine.connect() as conn:
            names = {r[0] for r in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))}
        self.assertTrue(set(self.NEW) <= names, names)

    def test_any_other_error_still_raises(self):
        from sqlalchemy.exc import OperationalError
        from app.database import Base, create_tables
        engine, _ = self.upgrade_db()
        err = OperationalError("CREATE TABLE x", {}, Exception("disk I/O error"))
        with mock.patch.object(Base.metadata, "create_all", side_effect=err) as create_all:
            with self.assertRaises(OperationalError):
                create_tables(engine)
        self.assertEqual(create_all.call_count, 1)

    def test_init_db_uses_it(self):
        import inspect as pyinspect
        from app import database
        self.assertIn("create_tables(engine)", pyinspect.getsource(database.init_db))


class Prefs(StoreBase):
    def test_defaults(self):
        self.assertEqual(listening.get_prefs(self.db, ME), {"skip_s": 10, "speed": 1.0, "smart_rewind": True})

    def test_put_merges_and_returns(self):
        out = listening.put_prefs(self.db, ME, speed=1.25)
        self.assertEqual(out, {"skip_s": 10, "speed": 1.25, "smart_rewind": True})
        out = listening.put_prefs(self.db, ME, skip_s=30, smart_rewind=False)
        self.assertEqual(out, {"skip_s": 30, "speed": 1.25, "smart_rewind": False})
        self.assertEqual(listening.get_prefs(self.db, ME), out)

    def test_bounds(self):
        for v in (5, 60):
            self.assertEqual(listening.put_prefs(self.db, ME, skip_s=v)["skip_s"], v)
        for v in (0.75, 1.05, 1.5, 2.0):
            self.assertEqual(listening.put_prefs(self.db, ME, speed=v)["speed"], v)

    def test_validation(self):
        bad = [dict(skip_s=4), dict(skip_s=61), dict(skip_s=10.5), dict(skip_s=True), dict(skip_s="10"),
               dict(speed=2.05), dict(speed=0.7), dict(speed=1.03), dict(speed="1.0"), dict(speed=float("nan")),
               dict(smart_rewind="yes"), dict(volume=3),
               # Too big for float arithmetic: a ValueError, never an OverflowError.
               dict(speed=1e308), dict(speed=-1e308), dict(speed=10 ** 400), dict(speed=-(10 ** 400)),
               dict(speed=float("inf")), dict(speed=float("-inf")), dict(skip_s=10 ** 400)]
        for kw in bad:
            with self.subTest(kw):
                with self.assertRaises(ValueError):
                    listening.put_prefs(self.db, ME, **kw)
        self.assertEqual(listening.get_prefs(self.db, ME), {"skip_s": 10, "speed": 1.0, "smart_rewind": True})


class Pruning(StoreBase):
    NOW = datetime(2026, 9, 28, 12, 0, 0)

    def add_log(self, days_ago):
        from app.models import ListeningLog
        self.db.add(ListeningLog(identity=ME, book_key=BOOK, track_key="6001", offset_ms=days_ago,
                                 device="d", event="checkin", at=self.NOW - timedelta(days=days_ago)))
        self.db.commit()

    def test_prune_removes_181_day_rows_and_keeps_179(self):
        self.add_log(181)
        self.add_log(179)
        self.add_log(1)
        self.assertEqual(listening.prune_log(self.db, now=self.NOW), 1)
        self.assertEqual(sorted(h["offset_ms"] for h in listening.get_history(self.db, ME, BOOK)), [1, 179])

    def test_prune_leaves_positions_alone(self):
        checkin(self.db)
        listening.prune_log(self.db, now=datetime.utcnow() + timedelta(days=400))
        self.assertIsNotNone(listening.get_position(self.db, ME, BOOK))

    def test_prune_if_due_runs_at_most_once_a_day(self):
        self.add_log(181)
        self.assertEqual(listening.prune_if_due(self.db, now=self.NOW), 1)
        self.assertIsNotNone(helpers.get(self.db, listening.PRUNED_AT_KEY), "a timestamp row, not a module cache")
        self.add_log(200)
        self.assertIsNone(listening.prune_if_due(self.db, now=self.NOW + timedelta(hours=23)))
        self.assertEqual(self.log_count(), 1)
        self.assertEqual(listening.prune_if_due(self.db, now=self.NOW + timedelta(hours=25)), 1)

    def test_a_bad_marker_does_not_stop_pruning(self):
        helpers.put(self.db, listening.PRUNED_AT_KEY, "not a time")
        self.add_log(181)
        self.assertEqual(listening.prune_if_due(self.db, now=self.NOW), 1)

    def test_the_marker_is_not_an_operator_setting(self):
        self.assertIsNone(reg.get_def(listening.PRUNED_AT_KEY))
        self.assertNotIn(listening.PRUNED_AT_KEY, reg.seed_defaults())

    def test_startup_prunes(self):
        from app import database
        self.add_log(181)
        with mock.patch.object(database, "engine", self.Session.kw["bind"]), \
                mock.patch.object(database, "SessionLocal", self.Session):
            database.init_db()
        self.assertEqual(self.log_count(), 0)
        self.assertIsNotNone(helpers.get(self.db, listening.PRUNED_AT_KEY))

    def test_a_checkin_prunes_when_due(self):
        from app.models import ListeningLog
        self.db.add(ListeningLog(identity=THEM, book_key=BOOK, track_key="6001", offset_ms=0, device="d",
                                 event="checkin", at=datetime.utcnow() - timedelta(days=200)))
        self.db.commit()
        checkin(self.db)
        self.assertEqual(self.log_count(THEM), 0)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class LibrarySetting(unittest.TestCase):
    def test_definition(self):
        d = reg.get_def(LIB_KEY)
        self.assertIsNotNone(d)
        self.assertEqual((d.type, d.default), ("text", ""))
        self.assertFalse(d.public, "admin-only: never in the public branding payload")
        self.assertFalse(d.secret)
        self.assertEqual(reg.seed_defaults()[LIB_KEY][0], "")
        from app.routers import branding
        self.assertNotIn(LIB_KEY, branding.DEFAULTS)

    def test_validation(self):
        for ok in ("", "1", "5", "123456"):
            self.assertIsNone(reg.validate_value(LIB_KEY, ok), ok)
        for bad in ("abc", "5a", " 5", "5 ", "-1", "1.5", " ", "٥", "1234567890123"):
            self.assertIsNotNone(reg.validate_value(LIB_KEY, bad), bad)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class LibrarySettingApi(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()
        self.db.close()

    def save(self, client, value):
        return client.put("/api/admin/settings/bulk", json={"settings": [{"key": LIB_KEY, "value": value}]})

    def test_admin_saves_and_reads_it(self):
        client = helpers.api_client(self.Session, helpers.ADMIN)
        self.assertEqual(self.save(client, "7").status_code, 200)
        self.assertEqual(helpers.get(self.db, LIB_KEY), "7")
        body = client.get("/api/admin/settings?view=registry").json()
        self.assertEqual(body["values"][LIB_KEY], "7")
        self.assertIn(LIB_KEY, body["meta"])
        r = self.save(client, "books")
        self.assertEqual(r.status_code, 422)
        self.assertIn(LIB_KEY, r.json()["errors"])
        self.assertEqual(self.save(client, "").status_code, 200)
        self.assertEqual(helpers.get(self.db, LIB_KEY), "")

    def test_members_cannot_read_or_write_it(self):
        helpers.put(self.db, LIB_KEY, "7")
        client = helpers.api_client(self.Session, helpers.MEMBER)
        self.assertEqual(self.save(client, "9").status_code, 403)
        self.assertEqual(client.get("/api/admin/settings?view=registry").status_code, 403)
        self.assertEqual(helpers.get(self.db, LIB_KEY), "7")
        r = client.get("/api/branding")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(LIB_KEY, r.text)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SettingsField(unittest.TestCase):
    def test_the_integrations_tab_shows_it_on_the_plex_card(self):
        from pathlib import Path
        import app
        src = (Path(app.__file__).parent / "static" / "js" / "settings" / "integrations.js").read_text(
            encoding="utf-8")
        plex = src[src.index("plex: {"):src.index("seerr: {")]
        self.assertIn("'integration.plex.audiobook_library'", plex)


if __name__ == "__main__":
    unittest.main()
