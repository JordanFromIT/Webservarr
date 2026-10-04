"""
The Books APIs (sub-project 3a, task 2): app/routers/books.py.

Kavita and Plex are faked at their function boundaries (the integrations'
own tests cover them, and the per-person Kavita calls are tested here at the
httpx layer); the catalog and the player's position store are the real ones on
an in-memory database, so what a caller may see, identity isolation and the
paging are exercised end to end. No test reaches Kavita, Plex, Redis or the dev
instance's settings.
"""
import base64
import json
import unittest
from datetime import datetime, timedelta
from unittest import mock
from urllib.parse import quote

from app.tests import helpers

try:
    import httpx
    from fastapi import HTTPException

    from app.config import settings
    from app.dependencies import get_current_user
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

if HAVE_APP:
    # Not in the guard above: a missing module of this work must fail the suite, not skip it.
    from app.integrations import kavita
    from app.integrations import plex_player as pp
    from app.main import app
    from app.models import Book, BookAudioEdition, BookPairOverride, ListeningLog, ListeningPosition
    from app.routers import books
    from app.services import book_catalog, listening

ORIGIN = "https://localhost"
KAVITA = "http://kavita.test:5000"
T0 = datetime(2026, 9, 1, 12, 0, 0)


def plex_user(account_id, **extra):
    u = {"user_id": account_id, "username": f"listener{account_id}", "display_name": "Listener",
         "is_admin": "false", "auth_method": "plex", "plex_account_id": account_id,
         "plex_token": f"PLEX-TOKEN-{account_id}", "email": "",
         "kavita_token": f"jwt-{account_id}", "kavita_base": KAVITA}
    u.update(extra)
    return u


A = plex_user("1001")
B = plex_user("1002")
ADMIN = plex_user("1900", is_admin="true")
LOCAL_ADMIN = {"user_id": "7", "username": "localsam", "is_admin": "true", "auth_method": "simple",
               "account_uid": "uid-7", "email": ""}


def when(days):
    return T0 + timedelta(days=days)


def make_book(db, id_, title, author="", series="", number=None, chapter=None, library=1, editions=(), added=0,
              merged_into=None, sort_title=None, cover="kavita"):
    """A catalog row. `editions` are (plex key, narrator) pairs; the first is the primary."""
    db.add(Book(id=id_, title=title, sort_title=sort_title or title, author=author, series=series,
                series_number=number, description=f"About {title}", kavita_chapter_id=chapter,
                kavita_series_id=(1000 + chapter) if chapter else None,
                kavita_library_id=library if chapter else None,
                plex_book_key=editions[0][0] if editions else None, added_at=when(added),
                updated_at=when(added), cover_source=cover if chapter else "plex", merged_into=merged_into))
    for i, (key, narrator) in enumerate(editions):
        db.add(BookAudioEdition(book_id=id_, plex_book_key=key, narrator=narrator, added_at=when(added + i)))
    db.commit()


def place(db, identity, key, at, book_ms=None, duration=None, end=False):
    db.add(ListeningPosition(identity=identity, book_key=key, track_key="t1", offset_ms=0, duration_ms=0,
                             updated_at=at, device="", source="web", book_ms=book_ms, book_duration_ms=duration))
    if end:
        db.add(ListeningLog(identity=identity, book_key=key, track_key="t1", offset_ms=0, event="end", at=at,
                            device="", book_ms=book_ms, book_duration_ms=duration))
    db.commit()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class BooksBase(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        # The library: Dune (ebook and two narrations), its sequel (ebook), a Dune book that is audio only and
        # has no number, a standalone ebook, one in a Kavita library nobody here reaches, and more.
        make_book(self.db, 1, "Dune", "Frank Herbert", "Dune", 1, 101, editions=[("10:1", "Scott Brick"),
                                                                                  ("11:1", "Simon Vance")], added=10)
        make_book(self.db, 2, "Dune Messiah", "Frank Herbert", "Dune", 2, 102, added=11)
        make_book(self.db, 3, "Children of Dune", "Frank Herbert", "Dune", None, editions=[("12:1", "Simon Vance")],
                  added=12)
        make_book(self.db, 4, "Emma", "Jane Austen", chapter=103, added=5)
        make_book(self.db, 5, "Secret Book", "Hidden Author", chapter=104, library=2, added=6)
        make_book(self.db, 6, "Villette", "Charlotte Brontë", chapter=105, editions=[("13:1", "Nora Reed")],
                  added=7)
        make_book(self.db, 7, "The Hobbit", "J. R. R. Tolkien", editions=[("14:1", "Rob Inglis")], added=8)
        make_book(self.db, 8, "Slash Tale", "A/B Author", editions=[("15:1", "Le Guin, Ursula K.")], added=9)
        make_book(self.db, 9, "Dune (old row)", "Frank Herbert", merged_into=1, added=1)
        self.libraries = mock.AsyncMock(return_value={1})
        self.in_progress = mock.AsyncMock(return_value=[])
        self.places = mock.AsyncMock(return_value={})
        self.chapter_number = mock.AsyncMock(return_value=None)
        self.kavita_cover = mock.AsyncMock(return_value=(b"\x89PNGk", "image/png"))
        self.library_access = mock.AsyncMock(return_value={"token": "x", "uris": {}})
        self.plex_cover = mock.AsyncMock(return_value=(b"\xff\xd8plex", "image/jpeg"))
        self.status = mock.AsyncMock(return_value={
            "last_rebuild_at": T0, "last_ok_at": T0, "counts": {"ebooks": 5, "audiobooks": 6, "books": 8},
            "errors": {"kavita": None, "plex": None}, "running": False})
        self.rebuild = mock.AsyncMock(return_value={"ok": True, "ebooks": 5, "audiobooks": 6, "books": 8,
                                                    "errors": {"kavita": None, "plex": None}, "skipped": False})
        self.on = mock.Mock(return_value=True)
        patches = [
            mock.patch("app.routers.setup.is_setup_completed", return_value=True),
            mock.patch.object(books.kavita_proxy, "kavita_url_for", side_effect=lambda user: KAVITA),
            mock.patch.object(kavita, "user_library_ids", self.libraries),
            mock.patch.object(kavita, "in_progress_series_ids", self.in_progress),
            mock.patch.object(kavita, "chapter_places", self.places),
            mock.patch.object(kavita, "chapter_number_at", self.chapter_number),
            mock.patch.object(kavita, "chapter_cover", self.kavita_cover),
            mock.patch.object(pp, "player_on", self.on),
            mock.patch.object(pp, "library_access", self.library_access),
            mock.patch.object(pp, "cover_image", self.plex_cover),
            mock.patch.object(book_catalog, "catalog_status", self.status),
            mock.patch.object(book_catalog, "rebuild", self.rebuild),
            mock.patch.object(settings, "app_domain", "localhost"),
            mock.patch.object(settings, "app_scheme", "https"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(helpers.reset_overrides)
        self.addCleanup(self.db.close)
        self.as_user(A)

    def as_user(self, user):
        self.client = helpers.api_client(self.Session, user)
        self.client.cookies.set(settings.session_cookie_name, f"sid-{user.get('user_id')}")
        return self.client

    def get(self, path, **params):
        return self.client.get(path, params=params, follow_redirects=False)

    def ok(self, path, **params):
        r = self.get(path, **params)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def titles(self, body):
        return [i.get("title") or i.get("series") for i in body["items"]]


class Library(BooksBase):
    def test_shape_and_series_collapse(self):
        body = self.ok("/api/books", sort="title")
        by = {(i["kind"], i.get("title") or i.get("series")): i for i in body["items"]}
        series = by[("series", "Dune")]
        self.assertEqual(series["count"], 3)
        self.assertEqual(series["cover_book_id"], 1)            # the first in reading order
        self.assertEqual(series["formats"], ["ebook", "audio"])
        self.assertEqual(series["author"], "Frank Herbert")
        book = by[("book", "Emma")]
        self.assertEqual(set(book), {"kind", "id", "title", "author", "cover_url", "formats"})
        self.assertTrue(book["cover_url"].startswith("/api/books/4/cover?v="))
        self.assertEqual(book["formats"], ["ebook"])
        self.assertEqual(by[("book", "The Hobbit")]["formats"], ["audio"])
        self.assertEqual(body["next_cursor"], None)
        self.assertEqual(body["notes"], [])
        self.assertNotIn(("book", "Dune"), by)                  # collapsed into its series
        self.assertNotIn(("book", "Dune (old row)"), by)        # a ghost is never a book

    def test_a_series_of_one_visible_book_is_shown_as_the_book(self):
        make_book(self.db, 20, "Lonely One", "Ann Author", "Solo Series", 1, 120)
        body = self.ok("/api/books")
        kinds = {(i.get("title") or i.get("series")): i["kind"] for i in body["items"]}
        self.assertEqual(kinds["Lonely One"], "book")
        self.assertNotIn("Solo Series", kinds)

    def test_format_chips(self):
        ebooks = self.ok("/api/books", format="ebook", sort="title")
        self.assertEqual(self.titles(ebooks), ["Dune", "Emma", "Villette"])
        self.assertEqual([i["count"] for i in ebooks["items"] if i["kind"] == "series"], [2])   # only its 2 ebooks
        audio = self.ok("/api/books", format="audio", sort="title")
        self.assertEqual(self.titles(audio), ["Dune", "Slash Tale", "The Hobbit", "Villette"])
        self.assertEqual([i["count"] for i in audio["items"] if i["kind"] == "series"], [2])
        both = next(i for i in audio["items"] if i.get("title") == "Villette")
        self.assertEqual(both["formats"], ["ebook", "audio"])   # a book in both still shows both badges

    def test_sorts(self):
        self.assertEqual(self.titles(self.ok("/api/books", sort="added")),
                         ["Dune", "Slash Tale", "The Hobbit", "Villette", "Emma"])
        self.assertEqual(self.titles(self.ok("/api/books", sort="title")),
                         ["Dune", "Emma", "Slash Tale", "The Hobbit", "Villette"])
        by_author = self.ok("/api/books", sort="author")
        # By surname: Austen, Author (A/B Author), Bront\u00eb, Herbert, Tolkien.
        self.assertEqual([i.get("title") or i["series"] for i in by_author["items"]],
                         ["Emma", "Slash Tale", "Villette", "Dune", "The Hobbit"])

    def test_validation(self):
        for params in ({"format": "video"}, {"sort": "random"}, {"limit": 0}, {"limit": 61}, {"limit": "x"},
                       {"cursor": ""}, {"cursor": "!!!"}, {"cursor": "x" * 5000}):
            with self.subTest(params=params):
                self.assertEqual(self.get("/api/books", **params).status_code, 422)
        self.assertEqual(self.get("/api/books", limit=60).status_code, 200)

    def test_cursor_paging_walks_every_card_once(self):
        for sort in ("added", "title", "author"):
            with self.subTest(sort=sort):
                seen, cursor = [], None
                for _round in range(10):
                    params = {"sort": sort, "limit": 2}
                    if cursor:
                        params["cursor"] = cursor
                    body = self.ok("/api/books", **params)
                    self.assertLessEqual(len(body["items"]), 2)
                    seen += self.titles(body)
                    cursor = body["next_cursor"]
                    if not cursor:
                        break
                self.assertEqual(seen, self.titles(self.ok("/api/books", sort=sort)))
                self.assertEqual(len(seen), len(set(seen)))

    def test_cursor_paging_is_stable_across_a_rebuild(self):
        first = self.ok("/api/books", sort="title", limit=2)
        self.assertEqual(self.titles(first), ["Dune", "Emma"])
        # A rebuild between the two requests: Emma goes, one book lands before the cursor and one after it.
        self.db.query(Book).filter(Book.id == 4).delete()
        make_book(self.db, 30, "Alpha", "Zed", chapter=130)
        make_book(self.db, 31, "Zulu", "Zed", chapter=131)
        self.db.commit()
        second = self.ok("/api/books", sort="title", limit=10, cursor=first["next_cursor"])
        self.assertEqual(self.titles(second), ["Slash Tale", "The Hobbit", "Villette", "Zulu"])
        self.assertIsNone(second["next_cursor"])

    def test_a_cursor_from_another_sort_is_refused(self):
        cursor = self.ok("/api/books", sort="title", limit=1)["next_cursor"]
        self.assertEqual(self.get("/api/books", sort="added", cursor=cursor).status_code, 422)
        forged = base64.urlsafe_b64encode(json.dumps(["title", [1, 2]]).encode()).decode()
        self.assertEqual(self.get("/api/books", sort="title", cursor=forged).status_code, 422)

    def test_a_year_one_date_from_kavita_is_not_an_error(self):
        make_book(self.db, 45, "Undated", "Zed", chapter=145)
        self.db.query(Book).filter(Book.id == 45).update({"added_at": datetime(1, 1, 1), "updated_at": datetime(1, 1, 1)})
        self.db.commit()
        for sort in ("added", "title", "author"):
            self.assertIn(45, [i.get("id") for i in self.ok("/api/books", sort=sort)["items"]])
        self.assertEqual(self.get("/api/books/search", q="undated").status_code, 200)
        self.assertEqual(self.get("/api/books/45").status_code, 200)

    def test_a_unicode_cursor_round_trips(self):
        make_book(self.db, 40, "Étude en rouge — " + "é" * 150, "Arthur Conan Doyle", chapter=140)
        make_book(self.db, 41, "Étude suivante", "Arthur Conan Doyle", chapter=141)
        seen, cursor = [], None
        for _round in range(12):
            params = {"sort": "author", "limit": 1}
            if cursor:
                params["cursor"] = cursor
            body = self.ok("/api/books", **params)
            seen += [i["id"] for i in body["items"] if i["kind"] == "book"]
            cursor = body["next_cursor"]
            if not cursor:
                break
        self.assertIn(40, seen)
        self.assertIn(41, seen)


class KavitaVisibility(BooksBase):
    """Review Focus 3: a caller sees an ebook only in a library their own Kavita account reaches."""

    def every_listing(self):
        found = {}
        found["grid"] = [i.get("id") for i in self.ok("/api/books")["items"] if i["kind"] == "book"]
        found["search"] = [i["id"] for i in self.ok("/api/books/search", q="secret")["items"]]
        return found

    def test_a_hidden_library_is_hidden_everywhere(self):
        self.assertEqual(self.libraries.await_count, 0)
        self.assertNotIn(5, self.every_listing()["grid"])
        self.assertEqual(self.every_listing()["search"], [])
        self.assertEqual(self.get("/api/books/5").status_code, 404)
        self.assertEqual(self.get("/api/books/5/cover").status_code, 404)
        self.assertEqual(self.get("/api/books/person", role="author", name="Hidden Author").status_code, 404)
        make_book(self.db, 50, "Secret Two", "Hidden Author", "Secret Series", 1, 150, library=2)
        make_book(self.db, 51, "Secret Three", "Hidden Author", "Secret Series", 2, 151, library=2)
        self.assertEqual(self.get("/api/books/series", name="Secret Series").status_code, 404)
        self.assertNotIn("Secret Series", [i.get("series") for i in self.ok("/api/books")["items"]])
        self.in_progress.return_value = [1004]
        self.places.return_value = {104: {"page": 5, "pages": 50, "at": when(30)}}
        self.assertEqual(self.ok("/api/books/continue")["items"], [])

    def test_a_library_the_account_reaches_is_shown(self):
        self.libraries.return_value = {1, 2}
        self.assertIn(5, self.every_listing()["grid"])
        self.assertEqual(self.get("/api/books/5").status_code, 200)

    def test_an_ebook_in_a_hidden_library_of_a_paired_book_keeps_only_its_audio(self):
        self.libraries.return_value = {2}
        body = self.ok("/api/books/1")
        self.assertIsNone(body["formats"]["ebook"])
        self.assertEqual([e["plex_book_key"] for e in body["formats"]["audio"]["editions"]], ["10:1", "11:1"])
        self.assertEqual(self.get("/api/books/2").status_code, 404)          # an ebook only

    def test_unreadable_libraries_show_no_ebooks_not_all_of_them(self):
        for failure in (kavita.KavitaUnavailable("Kavita did not answer"), kavita.KavitaTokenRefused("expired")):
            with self.subTest(failure=type(failure).__name__):
                self.libraries.side_effect = failure
                body = self.ok("/api/books")
                for item in body["items"]:
                    self.assertNotIn("ebook", item["formats"], item)
                self.assertEqual(self.get("/api/books/4").status_code, 404)
                self.assertEqual(self.get("/api/books/4/cover").status_code, 404)
                self.assertEqual([n["source"] for n in body["notes"]], ["kavita"])
                self.assertEqual(self.ok("/api/books/search", q="emma")["items"], [])
        self.libraries.side_effect = kavita.KavitaUnavailable("down")
        self.assertEqual(self.ok("/api/books")["notes"][0]["reason"], "unavailable")
        self.libraries.side_effect = kavita.KavitaTokenRefused("expired")
        self.assertEqual(self.ok("/api/books")["notes"][0]["reason"], "not_connected")

    def test_a_caller_with_no_kavita_token_sees_no_ebooks(self):
        self.as_user(plex_user("1003", kavita_token=""))
        body = self.ok("/api/books")
        self.assertTrue(all("ebook" not in i["formats"] for i in body["items"]))
        self.assertEqual(body["notes"][0]["reason"], "not_connected")
        self.libraries.assert_not_awaited()

    def test_a_token_from_another_kavita_address_is_not_used(self):
        self.as_user(plex_user("1003", kavita_base="http://old-kavita.test:5000"))
        self.assertTrue(all("ebook" not in i["formats"] for i in self.ok("/api/books")["items"]))
        self.libraries.assert_not_awaited()

    def test_ebooks_switched_off_for_members_show_no_ebooks_and_no_note(self):
        with mock.patch.object(books.kavita_proxy, "kavita_url_for",
                               side_effect=HTTPException(status_code=403, detail="eBooks is turned off")):
            body = self.ok("/api/books")
        self.assertTrue(all("ebook" not in i["formats"] for i in body["items"]))
        self.assertEqual(body["notes"], [])

    def test_the_callers_own_token_is_what_asks_kavita(self):
        self.ok("/api/books")
        self.libraries.assert_awaited_with(KAVITA, "jwt-1001")
        self.as_user(B)
        self.ok("/api/books")
        self.libraries.assert_awaited_with(KAVITA, "jwt-1002")


class AudioVisibility(BooksBase):
    def test_a_caller_without_a_plex_identity_sees_no_audiobooks(self):
        self.as_user(LOCAL_ADMIN)
        body = self.ok("/api/books")
        self.assertTrue(all("audio" not in i["formats"] for i in body["items"]))
        self.assertEqual(self.get("/api/books/7").status_code, 404)      # audio only
        self.assertEqual(self.get("/api/books/person", role="narrator", name="Rob Inglis").status_code, 404)
        self.library_access.assert_not_awaited()

    def test_a_share_without_the_audiobook_library_hides_audio_quietly(self):
        self.library_access.side_effect = pp.NoLibraryAccess("no")
        body = self.ok("/api/books")
        self.assertTrue(all("audio" not in i["formats"] for i in body["items"]))
        self.assertEqual(body["notes"], [])
        self.assertEqual(self.get("/api/books/7").status_code, 404)

    def test_plex_unconfirmable_hides_audio_with_a_note(self):
        self.library_access.side_effect = pp.PlayerUnavailable("down")
        body = self.ok("/api/books")
        self.assertTrue(all("audio" not in i["formats"] for i in body["items"]))
        self.assertEqual([n["source"] for n in body["notes"]], ["plex"])

    def test_the_player_off_hides_audio(self):
        self.on.return_value = False
        self.assertTrue(all("audio" not in i["formats"] for i in self.ok("/api/books")["items"]))


class BookPage(BooksBase):
    def test_a_paired_book_with_two_editions(self):
        body = self.ok("/api/books/1")
        self.assertEqual(body["book"]["id"], 1)
        self.assertEqual(body["book"]["title"], "Dune")
        self.assertEqual(body["book"]["narrators"], ["Scott Brick", "Simon Vance"])
        self.assertEqual(body["book"]["series"], "Dune")
        self.assertEqual(body["formats"]["ebook"], {"available": True, "progress": None,
                                                    "read_url": "/reader?seriesId=1101&chapterId=101"})
        audio = body["formats"]["audio"]
        self.assertTrue(audio["available"])
        self.assertEqual(audio["preferred"], "10:1")                     # no place: the primary edition
        self.assertEqual(audio["editions"], [
            {"plex_book_key": "10:1", "narrator": "Scott Brick", "progress": None, "in_progress": False},
            {"plex_book_key": "11:1", "narrator": "Simon Vance", "progress": None, "in_progress": False}])
        self.assertEqual(body["request_links"], {"ebook": None, "audio": None})
        self.assertEqual(body["notes"], [])

    def test_preferred_is_the_edition_with_the_newest_place(self):
        place(self.db, "plex:1001", "10:1", when(20), book_ms=1_000_000, duration=10_000_000)
        place(self.db, "plex:1001", "11:1", when(21), book_ms=2_200_000, duration=10_000_000)
        audio = self.ok("/api/books/1")["formats"]["audio"]
        self.assertEqual(audio["preferred"], "11:1")
        first, second = audio["editions"]
        self.assertTrue(first["in_progress"] and second["in_progress"])
        self.assertEqual(second["progress"]["label"], "2h 10m left")
        self.assertEqual(second["progress"]["percent"], 22)
        self.assertEqual(second["progress"]["finished"], False)
        self.assertEqual(first["progress"]["label"], "2h 30m left")

    def test_a_finished_edition_is_not_in_progress_but_can_still_be_preferred(self):
        place(self.db, "plex:1001", "10:1", when(20), book_ms=9_900_000, duration=10_000_000)
        place(self.db, "plex:1001", "11:1", when(19), book_ms=0, duration=10_000_000, end=True)
        audio = self.ok("/api/books/1")["formats"]["audio"]
        self.assertEqual(audio["preferred"], "10:1")                     # the newest place, finished (99%) or not
        self.assertEqual([e["in_progress"] for e in audio["editions"]], [False, False])
        self.assertEqual(audio["editions"][0]["progress"]["label"], "Finished")
        self.assertEqual(audio["editions"][1]["progress"]["percent"], 100)

    def test_a_place_without_a_book_position_is_in_progress(self):
        place(self.db, "plex:1001", "10:1", when(20))
        edition = self.ok("/api/books/1")["formats"]["audio"]["editions"][0]
        self.assertTrue(edition["in_progress"])
        self.assertEqual(edition["progress"]["label"], "In progress")
        self.assertIsNone(edition["progress"]["percent"])

    def test_places_are_the_callers_own(self):
        place(self.db, "plex:1002", "10:1", when(20), book_ms=1_000_000, duration=10_000_000)
        audio = self.ok("/api/books/1")["formats"]["audio"]                  # A has no place; B has one
        self.assertEqual(audio["editions"][0]["progress"], None)
        self.as_user(B)
        self.assertEqual(self.ok("/api/books/1")["formats"]["audio"]["editions"][0]["progress"]["label"],
                         "2h 30m left")

    def test_ebook_progress_comes_from_kavita_with_the_chapter_number(self):
        self.places.return_value = {101: {"page": 20, "pages": 41, "at": when(25)}}
        self.chapter_number.return_value = 12
        progress = self.ok("/api/books/1")["formats"]["ebook"]["progress"]
        self.assertEqual(progress["label"], "Ch. 12 · 50%")
        self.assertEqual(progress["percent"], 50)
        self.assertFalse(progress["finished"])
        self.places.assert_awaited_with(KAVITA, "jwt-1001", [101])
        self.chapter_number.assert_awaited_with(KAVITA, "jwt-1001", 101, 20)
        self.chapter_number.return_value = None
        self.assertEqual(self.ok("/api/books/1")["formats"]["ebook"]["progress"]["label"], "50%")

    def test_a_finished_ebook(self):
        self.places.return_value = {101: {"page": 40, "pages": 41, "at": when(25)}}
        progress = self.ok("/api/books/1")["formats"]["ebook"]["progress"]
        self.assertEqual((progress["label"], progress["percent"], progress["finished"]), ("Finished", 100, True))
        self.chapter_number.assert_not_awaited()

    def test_kavita_failing_on_progress_keeps_the_book_and_adds_a_note(self):
        self.places.side_effect = kavita.KavitaUnavailable("down")
        body = self.ok("/api/books/1")
        self.assertTrue(body["formats"]["ebook"]["available"])
        self.assertIsNone(body["formats"]["ebook"]["progress"])
        self.assertEqual([n["source"] for n in body["notes"]], ["kavita"])

    def test_request_links_are_for_a_format_the_catalog_lacks(self):
        ebook_only = self.ok("/api/books/4")
        self.assertIsNone(ebook_only["formats"]["audio"])
        self.assertEqual(ebook_only["request_links"],
                         {"ebook": None, "audio": "/requests?q=" + quote("Emma Jane Austen", safe="")})
        audio_only = self.ok("/api/books/7")
        self.assertIsNone(audio_only["formats"]["ebook"])
        self.assertEqual(audio_only["request_links"]["ebook"], "/requests?q=" + quote("The Hobbit J. R. R. Tolkien", safe=""))
        self.assertIsNone(audio_only["request_links"]["audio"])

    def test_a_hidden_format_is_not_offered_for_request(self):
        self.libraries.return_value = {2}                                    # Dune's ebook is not theirs to see
        self.assertIsNone(self.ok("/api/books/1")["request_links"]["ebook"])

    def test_a_merged_id_redirects_to_the_surviving_book(self):
        r = self.get("/api/books/9")
        self.assertEqual(r.status_code, 301)
        self.assertEqual(r.headers["location"], "/api/books/1")
        followed = self.client.get("/api/books/9")
        self.assertEqual(followed.json()["book"]["id"], 1)
        cover = self.get("/api/books/9/cover")
        self.assertEqual((cover.status_code, cover.headers["location"]), (301, "/api/books/1/cover"))

    def test_a_chain_of_ghosts_that_leads_nowhere_is_404(self):
        make_book(self.db, 60, "Ghost A", merged_into=61)
        make_book(self.db, 61, "Ghost B", merged_into=999)
        self.assertEqual(self.get("/api/books/60").status_code, 404)

    def test_unknown_and_malformed_ids(self):
        self.assertEqual(self.get("/api/books/9999").status_code, 404)
        for bad in ("0", "-1", "abc", str(2 ** 40), "1.5"):
            with self.subTest(id=bad):
                self.assertEqual(self.get(f"/api/books/{bad}").status_code, 422)

    def test_a_ghost_whose_survivor_is_hidden_ends_in_404(self):
        make_book(self.db, 62, "Old Secret", merged_into=5)
        r = self.client.get("/api/books/62")
        self.assertEqual(r.status_code, 404)


class Search(BooksBase):
    def found(self, q):
        body = self.ok("/api/books/search", q=q)
        return [i["id"] for i in body["items"]]

    def test_shape_and_the_request_url(self):
        body = self.ok("/api/books/search", q="dune")
        self.assertEqual(body["request_url"], "/requests?q=dune")
        self.assertEqual(set(body["items"][0]), {"kind", "id", "title", "author", "cover_url", "formats"})
        none = self.ok("/api/books/search", q="Nothing & Nowhere / 100%")
        self.assertEqual(none["items"], [])
        self.assertEqual(none["request_url"], "/requests?q=Nothing%20%26%20Nowhere%20%2F%20100%25")

    def test_ranking_is_title_then_series_then_people(self):
        make_book(self.db, 70, "Herbert's Tale", "Someone Else", chapter=170)
        make_book(self.db, 71, "Plain Title", "Ann Author", "The Herbert Saga", 1, 171)
        make_book(self.db, 72, "Another Title", "Frank Herbert", chapter=172)
        # "herbert": title (70), series (71), then the people, by title.
        self.assertEqual(self.found("herbert"), [70, 71, 72, 3, 1, 2])

    def test_a_title_that_starts_with_the_term_beats_one_that_holds_it(self):
        make_book(self.db, 73, "The Great Dune", "A", chapter=173)
        self.assertEqual(self.found("dune")[:4], [1, 2, 3, 73])          # starts with it: Dune, Dune Messiah, Children... (series)

    def test_case_and_accents_are_ignored(self):
        for q in ("bronte", "BRONTË", "Brontë", "charlotte bronte", "villette"):
            with self.subTest(q=q):
                self.assertEqual(self.found(q), [6])
        make_book(self.db, 74, "Café Society", "Zed", chapter=174)
        self.assertEqual(self.found("CAFE"), [74])
        self.assertEqual(self.found("café"), [74])

    def test_narrators_are_searched(self):
        self.assertEqual(self.found("inglis"), [7])
        self.assertEqual(self.found("simon vance"), [3, 1])                # both books narrated, by title
        self.as_user(LOCAL_ADMIN)                                            # no audio: no narrator hits
        self.assertEqual(self.found("inglis"), [])

    def test_validation(self):
        self.assertEqual(self.get("/api/books/search").status_code, 422)
        self.assertEqual(self.get("/api/books/search", q="").status_code, 422)
        self.assertEqual(self.get("/api/books/search", q="   ").status_code, 422)
        self.assertEqual(self.get("/api/books/search", q="x" * 101).status_code, 422)
        self.assertEqual(self.get("/api/books/search", q="x" * 100).status_code, 200)
        self.assertEqual(self.get("/api/books/search", q="dune", limit=61).status_code, 422)
        self.assertEqual(len(self.ok("/api/books/search", q="dune", limit=2)["items"]), 2)


class PeopleAndSeries(BooksBase):
    def test_author_page(self):
        body = self.ok("/api/books/person", role="author", name="Frank Herbert")
        self.assertEqual(body["name"], "Frank Herbert")
        self.assertEqual(body["role"], "author")
        self.assertEqual([i["id"] for i in body["items"]], [1, 2, 3])        # the series in reading order, none last
        self.assertEqual(self.ok("/api/books/person", role="author", name="  frank   HERBERT ")["name"], "Frank Herbert")

    def test_names_with_punctuation_unicode_commas_and_slashes_round_trip(self):
        make_book(self.db, 80, "Lord of the Rings", "J.R.R. Tolkien", chapter=180)
        make_book(self.db, 81, "Left Hand of Darkness", "Le Guin, Ursula K.", chapter=181)
        make_book(self.db, 82, "Dispossessed", "Ursula K. Le Guin", "Hainish/Ekumen", 1, 182)
        make_book(self.db, 83, "Dispossessed Two", "Ursula K. Le Guin", "Hainish/Ekumen", 2, 183)
        for name, ids in (("J. R. R. Tolkien", [7]), ("J.R.R. Tolkien", [80]), ("Charlotte Brontë", [6]),
                          ("Le Guin, Ursula K.", [81]), ("A/B Author", [8])):
            with self.subTest(name=name):
                body = self.ok("/api/books/person", role="author", name=name)
                self.assertEqual([i["id"] for i in body["items"]], ids)
        self.assertEqual(self.get("/api/books/person", role="author", name="Charlotte Bronte").status_code, 404)
        series = self.ok("/api/books/series", name="Hainish/Ekumen")
        self.assertEqual([i["id"] for i in series["items"]], [82, 83])
        # Through the URL exactly as a browser builds it.
        r = self.client.get("/api/books/person?role=author&name=" + quote("A/B Author", safe=""))
        self.assertEqual(r.status_code, 200)
        r = self.client.get("/api/books/series?name=" + quote("Hainish/Ekumen", safe=""))
        self.assertEqual(r.json()["name"], "Hainish/Ekumen")

    def test_narrator_page_matches_edition_narrators(self):
        body = self.ok("/api/books/person", role="narrator", name="simon vance")
        self.assertEqual([i["id"] for i in body["items"]], [1, 3])
        self.assertEqual(body["name"], "Simon Vance")
        self.assertEqual([i["id"] for i in self.ok("/api/books/person", role="narrator",
                                                   name="Le Guin, Ursula K.")["items"]], [8])
        self.assertEqual(self.get("/api/books/person", role="narrator", name="Frank Herbert").status_code, 404)

    def test_validation(self):
        self.assertEqual(self.get("/api/books/person", name="x").status_code, 422)
        self.assertEqual(self.get("/api/books/person", role="editor", name="x").status_code, 422)
        self.assertEqual(self.get("/api/books/person", role="author").status_code, 422)
        self.assertEqual(self.get("/api/books/person", role="author", name="").status_code, 422)
        self.assertEqual(self.get("/api/books/person", role="author", name="x" * 201).status_code, 422)
        self.assertEqual(self.get("/api/books/series").status_code, 422)
        self.assertEqual(self.get("/api/books/series", name="x" * 201).status_code, 422)
        self.assertEqual(self.get("/api/books/series", name="Nope").status_code, 404)

    def test_series_in_reading_order_with_unnumbered_last(self):
        make_book(self.db, 90, "Dune Zero", "Frank Herbert", "Dune", 0.5, 190)
        body = self.ok("/api/books/series", name="dune")
        self.assertEqual(body["name"], "Dune")
        self.assertEqual([i["id"] for i in body["items"]], [90, 1, 2, 3])
        self.assertEqual([i["series_number"] for i in body["items"]], [0.5, 1, 2, None])

    def test_series_entries_carry_the_callers_progress(self):
        place(self.db, "plex:1001", "12:1", when(30), book_ms=1_000_000, duration=4_000_000)
        self.places.return_value = {102: {"page": 10, "pages": 21, "at": when(31)}}
        items = {i["id"]: i for i in self.ok("/api/books/series", name="Dune")["items"]}
        self.assertEqual(items[3]["progress"]["audio"]["label"], "50m left")
        self.assertIsNone(items[3]["progress"]["ebook"])
        self.assertEqual(items[2]["progress"]["ebook"]["label"], "50%")
        self.assertEqual(items[1]["progress"], {"ebook": None, "audio": None})
        self.as_user(B)
        self.assertIsNone(self.ok("/api/books/series", name="Dune")["items"][2]["progress"]["audio"])

    def test_series_page_with_kavita_down_still_lists_the_books(self):
        self.places.side_effect = kavita.KavitaUnavailable("down")
        body = self.ok("/api/books/series", name="Dune")
        self.assertEqual([i["id"] for i in body["items"]], [1, 2, 3])
        self.assertEqual([n["source"] for n in body["notes"]], ["kavita"])


class Continue(BooksBase):
    def test_nothing_in_progress(self):
        self.assertEqual(self.ok("/api/books/continue"), {"items": [], "notes": []})

    def test_audio_items_newest_first_with_the_time_left(self):
        place(self.db, "plex:1001", "13:1", when(40), book_ms=500_000, duration=4_100_000)
        place(self.db, "plex:1001", "14:1", when(41), book_ms=100_000, duration=7_300_000)
        items = self.ok("/api/books/continue")["items"]
        self.assertEqual([i["book_id"] for i in items], [7, 6])
        self.assertEqual(items[0], {
            "book_id": 7, "format": "audio", "title": "The Hobbit", "author": "J. R. R. Tolkien",
            "cover_url": items[0]["cover_url"], "progress_label": "2h left", "percent": 1,
            "updated_at": "2026-10-12T12:00:00.000Z", "resume": {"plex_book_key": "14:1"}})
        self.assertEqual(items[1]["progress_label"], "1h left")

    def test_a_finished_audiobook_is_not_in_the_row(self):
        place(self.db, "plex:1001", "14:1", when(41), book_ms=7_290_000, duration=7_300_000)
        place(self.db, "plex:1001", "13:1", when(40), book_ms=0, duration=4_100_000, end=True)
        self.assertEqual(self.ok("/api/books/continue")["items"], [])

    def test_a_book_in_several_editions_is_one_item_under_the_newest(self):
        place(self.db, "plex:1001", "10:1", when(50), book_ms=1_000_000, duration=10_000_000)
        place(self.db, "plex:1001", "11:1", when(52), book_ms=2_200_000, duration=10_000_000)
        items = self.ok("/api/books/continue")["items"]
        self.assertEqual([(i["book_id"], i["resume"]) for i in items], [(1, {"plex_book_key": "11:1"})])

    def test_an_unfinished_older_edition_stands_in_for_a_finished_newer_one(self):
        place(self.db, "plex:1001", "10:1", when(50), book_ms=1_000_000, duration=10_000_000)
        place(self.db, "plex:1001", "11:1", when(52), book_ms=0, duration=10_000_000, end=True)
        self.assertEqual(self.ok("/api/books/continue")["items"][0]["resume"], {"plex_book_key": "10:1"})

    def ebook_place(self, page=20, pages=41, at=None):
        self.in_progress.return_value = [1101, 1102]
        self.places.return_value = {101: {"page": page, "pages": pages, "at": at or when(60)}}

    def test_an_ebook_item(self):
        self.ebook_place()
        self.chapter_number.return_value = 12
        items = self.ok("/api/books/continue")["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual((items[0]["book_id"], items[0]["format"]), (1, "ebook"))
        self.assertEqual(items[0]["progress_label"], "Ch. 12 · 50%")
        self.assertEqual(items[0]["resume"], {"read_url": "/reader?seriesId=1101&chapterId=101"})
        self.in_progress.assert_awaited_with(KAVITA, "jwt-1001")
        self.assertEqual(sorted(self.places.await_args.args[2]), [101, 102])

    def test_a_finished_ebook_is_not_in_the_row(self):
        self.ebook_place(page=40, pages=41)
        self.assertEqual(self.ok("/api/books/continue")["items"], [])

    def test_a_book_in_both_formats_is_one_item_under_the_newer_activity(self):
        self.ebook_place(at=when(60))
        place(self.db, "plex:1001", "10:1", when(55), book_ms=1_000_000, duration=10_000_000)
        items = self.ok("/api/books/continue")["items"]
        self.assertEqual([(i["book_id"], i["format"]) for i in items], [(1, "ebook")])
        place(self.db, "plex:1001", "11:1", when(61), book_ms=1_000_000, duration=10_000_000)
        items = self.ok("/api/books/continue")["items"]
        self.assertEqual([(i["book_id"], i["format"]) for i in items], [(1, "audio")])

    def test_ordering_mixes_the_formats_newest_first(self):
        self.ebook_place(at=when(60))
        place(self.db, "plex:1001", "14:1", when(70), book_ms=1_000_000, duration=7_300_000)
        place(self.db, "plex:1001", "13:1", when(50), book_ms=1_000_000, duration=7_300_000)
        items = self.ok("/api/books/continue")["items"]
        self.assertEqual([(i["book_id"], i["format"]) for i in items], [(7, "audio"), (1, "ebook"), (6, "audio")])

    def test_at_most_twelve_items(self):
        for n in range(15):
            make_book(self.db, 200 + n, f"Book {n}", "Many", editions=[(f"{300 + n}:1", "N")])
            place(self.db, "plex:1001", f"{300 + n}:1", when(100 + n), book_ms=1000, duration=10_000_000)
        items = self.ok("/api/books/continue")["items"]
        self.assertEqual(len(items), 12)
        self.assertEqual([i["book_id"] for i in items], list(range(214, 202, -1)))

    def test_kavita_down_gives_the_audiobooks_and_a_note(self):
        place(self.db, "plex:1001", "14:1", when(41), book_ms=100_000, duration=7_300_000)
        self.in_progress.side_effect = kavita.KavitaUnavailable("Kavita did not answer")
        r = self.get("/api/books/continue")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual([i["book_id"] for i in body["items"]], [7])
        self.assertEqual([(n["source"], n["reason"]) for n in body["notes"]], [("kavita", "unavailable")])
        self.assertTrue(body["notes"][0]["text"])

    def test_kavita_failing_after_the_series_were_listed_drops_every_ebook_item(self):
        place(self.db, "plex:1001", "14:1", when(41), book_ms=100_000, duration=7_300_000)
        self.in_progress.return_value = [1101]
        self.places.side_effect = kavita.KavitaUnavailable("Kavita answered HTTP 500")
        body = self.ok("/api/books/continue")
        self.assertEqual([i["format"] for i in body["items"]], ["audio"])
        self.assertEqual([n["source"] for n in body["notes"]], ["kavita"])

    def test_plex_unconfirmable_gives_the_ebooks_and_a_note(self):
        self.ebook_place()
        place(self.db, "plex:1001", "14:1", when(41), book_ms=100_000, duration=7_300_000)
        self.library_access.side_effect = pp.PlayerUnavailable("down")
        body = self.ok("/api/books/continue")
        self.assertEqual([i["format"] for i in body["items"]], ["ebook"])
        self.assertEqual([n["source"] for n in body["notes"]], ["plex"])

    def test_identity_isolation(self):
        place(self.db, "plex:1002", "14:1", when(41), book_ms=100_000, duration=7_300_000)
        self.assertEqual(self.ok("/api/books/continue")["items"], [])        # A sees none of B's places
        self.as_user(B)
        self.assertEqual([i["book_id"] for i in self.ok("/api/books/continue")["items"]], [7])

    def test_audio_places_in_books_the_caller_cannot_reach_are_left_out(self):
        place(self.db, "plex:1001", "14:1", when(41), book_ms=100_000, duration=7_300_000)
        self.library_access.side_effect = pp.NoLibraryAccess("no")
        self.assertEqual(self.ok("/api/books/continue")["items"], [])

    def test_a_place_in_a_book_that_left_the_catalog_is_left_out(self):
        place(self.db, "plex:1001", "999:1", when(41), book_ms=100_000, duration=7_300_000)
        self.assertEqual(self.ok("/api/books/continue")["items"], [])


class Cover(BooksBase):
    def test_the_books_own_source_first(self):
        r = self.get("/api/books/1/cover")
        self.assertEqual((r.status_code, r.headers["content-type"], r.content), (200, "image/png", b"\x89PNGk"))
        self.kavita_cover.assert_awaited_with(101)
        self.plex_cover.assert_not_awaited()
        self.assertIn("private", r.headers["cache-control"])
        self.assertEqual(r.headers["content-security-policy"], "sandbox")
        self.assertEqual(r.headers["x-content-type-options"], "nosniff")

    def test_an_audiobook_only_book_uses_plex(self):
        r = self.get("/api/books/7/cover")
        self.assertEqual((r.status_code, r.headers["content-type"]), (200, "image/jpeg"))
        self.plex_cover.assert_awaited_with("14:1")

    def test_a_missing_cover_falls_back_to_the_other_source(self):
        self.kavita_cover.side_effect = kavita.KavitaNoCover()
        r = self.get("/api/books/1/cover")
        self.assertEqual((r.status_code, r.content), (200, b"\xff\xd8plex"))

    def test_no_cover_anywhere_is_404_and_an_outage_is_503(self):
        self.kavita_cover.side_effect = kavita.KavitaNoCover()
        self.assertEqual(self.get("/api/books/4/cover").status_code, 404)
        self.kavita_cover.side_effect = kavita.KavitaUnavailable("down")
        self.assertEqual(self.get("/api/books/4/cover").status_code, 503)
        self.plex_cover.side_effect = pp.NotInLibrary("no cover")
        self.assertEqual(self.get("/api/books/1/cover").status_code, 503)    # Kavita is down, Plex has none
        self.kavita_cover.side_effect = kavita.KavitaNoCover()
        self.assertEqual(self.get("/api/books/1/cover").status_code, 404)

    def test_a_source_the_caller_cannot_see_is_not_read(self):
        self.libraries.return_value = {2}
        self.get("/api/books/1/cover")
        self.kavita_cover.assert_not_awaited()
        self.plex_cover.assert_awaited_with("10:1")

    def test_unknown_and_malformed_ids(self):
        self.assertEqual(self.get("/api/books/9999/cover").status_code, 404)
        self.assertEqual(self.get("/api/books/0/cover").status_code, 422)


class Authentication(BooksBase):
    PATHS = ["/api/books", "/api/books/1", "/api/books/1/cover", "/api/books/search?q=a",
             "/api/books/person?role=author&name=a", "/api/books/series?name=a", "/api/books/continue",
             "/api/admin/books/status", "/api/admin/books/unpaired", "/api/admin/books/overrides"]

    def test_401_without_a_session(self):
        app.dependency_overrides.pop(get_current_user)
        self.client.cookies.clear()
        for path in self.PATHS:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 401)
        for method, path in (("post", "/api/admin/books/rebuild"), ("post", "/api/admin/books/overrides"),
                             ("delete", "/api/admin/books/overrides")):
            with self.subTest(path=path, method=method):
                self.assertEqual(getattr(self.client, method)(path, headers={"Origin": ORIGIN}).status_code, 401)

    def test_every_route_works_for_a_member(self):
        for path in self.PATHS[:3] + ["/api/books/search?q=a", "/api/books/person?role=author&name=Jane%20Austen",
                                      "/api/books/series?name=Dune", "/api/books/continue"]:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200)

    def test_admin_routes_refuse_a_member(self):
        for path in self.PATHS[7:]:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 403)
        body = {"kavita_chapter_id": 101, "plex_book_key": "10:1", "action": "pair"}
        self.assertEqual(self.client.post("/api/admin/books/rebuild", headers={"Origin": ORIGIN}).status_code, 403)
        self.assertEqual(self.client.post("/api/admin/books/overrides", json=body,
                                          headers={"Origin": ORIGIN}).status_code, 403)
        self.assertEqual(self.client.delete("/api/admin/books/overrides?kavita_chapter_id=101&plex_book_key=10:1",
                                            headers={"Origin": ORIGIN}).status_code, 403)
        self.rebuild.assert_not_awaited()
        self.assertEqual(self.db.query(BookPairOverride).count(), 0)


class Admin(BooksBase):
    def setUp(self):
        super().setUp()
        self.as_user(ADMIN)

    def post(self, path, json_body=None, origin=ORIGIN):
        headers = {"Origin": origin} if origin else {}
        return self.client.post(path, json=json_body, headers=headers)

    def test_status(self):
        body = self.ok("/api/admin/books/status")
        self.assertEqual(body, {"last_rebuild_at": "2026-09-01T12:00:00.000Z", "last_ok_at": "2026-09-01T12:00:00.000Z",
                                "counts": {"ebooks": 5, "audiobooks": 6, "books": 8},
                                "errors": {"kavita": None, "plex": None}, "running": False})

    def test_rebuild(self):
        r = self.post("/api/admin/books/rebuild")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["ok"])
        self.rebuild.assert_awaited_once_with("manual")

    def test_rebuild_refuses_another_origin(self):
        self.assertEqual(self.post("/api/admin/books/rebuild", origin="https://evil.example").status_code, 403)
        self.assertEqual(self.post("/api/admin/books/rebuild", origin=None).status_code, 403)
        self.rebuild.assert_not_awaited()

    def test_unpaired_lists_both_sides_whole(self):
        body = self.ok("/api/admin/books/unpaired")
        # Unfiltered by any library: the hidden-library ebook is there for the admin.
        self.assertEqual(sorted(e["kavita_chapter_id"] for e in body["ebooks"]), [102, 103, 104])
        self.assertEqual(sorted(a["plex_book_key"] for a in body["audiobooks"]), ["12:1", "14:1", "15:1"])
        self.assertEqual(set(body["ebooks"][0]), {"book_id", "kavita_chapter_id", "title", "author", "series"})
        self.assertEqual(set(body["audiobooks"][0]),
                         {"book_id", "plex_book_key", "narrator", "title", "author", "series"})

    def test_overrides_round_trip(self):
        self.assertEqual(self.ok("/api/admin/books/overrides"), {"overrides": []})
        r = self.post("/api/admin/books/overrides", {"kavita_chapter_id": 103, "plex_book_key": "14:1",
                                                     "action": "pair"})
        self.assertEqual(r.status_code, 200, r.text)
        made = r.json()
        self.assertEqual((made["kavita_chapter_id"], made["plex_book_key"], made["action"], made["created_by"]),
                         (103, "14:1", "pair", "plex:1900"))
        listed = self.ok("/api/admin/books/overrides")["overrides"]
        self.assertEqual(len(listed), 1)
        self.assertEqual((listed[0]["ebook_title"], listed[0]["audio_title"]), ("Emma", "The Hobbit"))
        # A new pair for the same edition replaces the old.
        self.post("/api/admin/books/overrides", {"kavita_chapter_id": 102, "plex_book_key": "14:1", "action": "pair"})
        self.assertEqual([o["kavita_chapter_id"] for o in self.ok("/api/admin/books/overrides")["overrides"]], [102])
        r = self.client.delete("/api/admin/books/overrides", params={"kavita_chapter_id": 102,
                                                                     "plex_book_key": "14:1"},
                               headers={"Origin": ORIGIN})
        self.assertEqual((r.status_code, r.json()), (200, {"removed": True}))
        self.assertEqual(self.ok("/api/admin/books/overrides"), {"overrides": []})

    def test_the_catalog_must_know_both_sides(self):
        for body in ({"kavita_chapter_id": 999, "plex_book_key": "14:1", "action": "pair"},
                     {"kavita_chapter_id": 103, "plex_book_key": "999:1", "action": "pair"}):
            with self.subTest(body=body):
                self.assertEqual(self.post("/api/admin/books/overrides", body).status_code, 404)
        self.assertEqual(self.db.query(BookPairOverride).count(), 0)

    def test_override_validation(self):
        good = {"kavita_chapter_id": 103, "plex_book_key": "14:1", "action": "pair"}
        for change in ({"action": "merge"}, {"action": None}, {"kavita_chapter_id": 0}, {"kavita_chapter_id": "103"},
                       {"kavita_chapter_id": 2 ** 40}, {"kavita_chapter_id": True}, {"plex_book_key": "14"},
                       {"plex_book_key": "14:1; DROP TABLE books"}, {"plex_book_key": "\ud800:1"}, {"plex_book_key": 5}):
            body = {**good, **change}
            with self.subTest(change=change):
                r = self.client.post("/api/admin/books/overrides", content=json.dumps(body),
                                     headers={"Origin": ORIGIN, "Content-Type": "application/json"})
                self.assertEqual(r.status_code, 422, r.text)
        self.assertEqual(self.post("/api/admin/books/overrides", {"action": "pair"}).status_code, 422)
        self.assertEqual(self.db.query(BookPairOverride).count(), 0)

    def test_removing_what_is_not_there_is_404_and_params_are_checked(self):
        gone = self.client.delete("/api/admin/books/overrides",
                                  params={"kavita_chapter_id": 103, "plex_book_key": "14:1"},
                                  headers={"Origin": ORIGIN})
        self.assertEqual(gone.status_code, 404)
        for params in ({"kavita_chapter_id": 0, "plex_book_key": "14:1"},
                       {"kavita_chapter_id": 103, "plex_book_key": "bad"}, {"kavita_chapter_id": 103}):
            with self.subTest(params=params):
                self.assertEqual(self.client.delete("/api/admin/books/overrides", params=params,
                                                    headers={"Origin": ORIGIN}).status_code, 422)

    def test_override_writes_and_deletes_refuse_another_origin(self):
        body = {"kavita_chapter_id": 103, "plex_book_key": "14:1", "action": "apart"}
        self.assertEqual(self.post("/api/admin/books/overrides", body, origin="https://evil.example").status_code, 403)
        self.assertEqual(self.client.delete("/api/admin/books/overrides",
                                            params={"kavita_chapter_id": 103, "plex_book_key": "14:1"}).status_code,
                         403)

    def test_a_local_admin_is_recorded_by_identity_not_username(self):
        self.as_user(LOCAL_ADMIN)
        r = self.post("/api/admin/books/overrides", {"kavita_chapter_id": 103, "plex_book_key": "14:1",
                                                     "action": "apart"})
        self.assertEqual(r.json()["created_by"], "local:uid-7")


# --- listening.get_places (the player's position store) -------------------------------------

@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Places(unittest.TestCase):
    def setUp(self):
        self.db = helpers.make_sessionmaker()()
        self.addCleanup(self.db.close)

    def test_scoped_by_identity_and_keys(self):
        place(self.db, "plex:1", "1:1", when(1), 1000, 100_000)
        place(self.db, "plex:2", "1:1", when(2), 2000, 100_000)
        place(self.db, "plex:1", "2:1", when(3), 3000, 100_000)
        self.assertEqual(sorted(listening.get_places(self.db, "plex:1")), ["1:1", "2:1"])
        self.assertEqual(listening.get_places(self.db, "plex:1", keys=["2:1", "9:9"])["2:1"]["book_ms"], 3000)
        self.assertEqual(list(listening.get_places(self.db, "plex:1", keys=["2:1", "9:9"])), ["2:1"])
        self.assertEqual(listening.get_places(self.db, "plex:3"), {})
        self.assertEqual(listening.get_places(self.db, "plex:1", keys=[]), {})

    def test_finished_rules(self):
        place(self.db, "plex:1", "a:1", when(1), 97_000, 100_000)                 # 97 percent: finished
        place(self.db, "plex:1", "b:1", when(1), 96_000, 100_000)
        place(self.db, "plex:1", "c:1", when(1), 10, 100_000, end=True)           # an end that saved the row
        place(self.db, "plex:1", "d:1", when(1), None, None)                      # unknown: unfinished
        place(self.db, "plex:1", "e:1", when(1), 5, 0)                            # a zero length: unfinished
        place(self.db, "plex:1", "f:1", when(1), 10, 100_000)
        self.db.add(ListeningLog(identity="plex:1", book_key="f:1", track_key="t1", offset_ms=0, event="end",
                                 at=when(0), device=""))                           # an older end: listened again since
        self.db.commit()
        got = {k: v["finished"] for k, v in listening.get_places(self.db, "plex:1").items()}
        self.assertEqual(got, {"a:1": True, "b:1": False, "c:1": True, "d:1": False, "e:1": False, "f:1": False})

    def test_many_keys_are_chunked(self):
        for n in range(5):
            place(self.db, "plex:1", f"{n}:1", when(n))
        keys = [f"{n}:1" for n in range(5)] + [f"{n}:2" for n in range(1000)]
        self.assertEqual(len(listening.get_places(self.db, "plex:1", keys=keys)), 5)


# --- The person's own Kavita reads, at the httpx layer ---------------------------------------

@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class KavitaAsThePerson(unittest.TestCase):
    TOKEN = "SECRET-USER-JWT"
    KEY = "SECRET-SERVER-KEY"

    def setUp(self):
        self.requests = []
        self.answers = {}
        self.real_client = httpx.AsyncClient
        for p in (mock.patch.object(kavita.httpx, "AsyncClient", self.client),
                  mock.patch.object(kavita.integration_config, "read",
                                    lambda keys: {kavita.URL_KEY: KAVITA, kavita.API_KEY: self.KEY})):
            p.start()
            self.addCleanup(p.stop)

    def client(self, **kwargs):
        return self.real_client(transport=httpx.MockTransport(self.handle))

    def handle(self, request):
        self.requests.append(request)
        answer = self.answers.get(request.url.path)
        if callable(answer):
            answer = answer(request)
        if isinstance(answer, Exception):
            raise answer
        return answer if answer is not None else httpx.Response(404)

    def run_async(self, coro):
        import asyncio
        return asyncio.run(coro)

    def test_library_ids_are_read_with_the_persons_token(self):
        self.answers["/api/Library/libraries"] = httpx.Response(200, json=[{"id": 1, "name": "a"}, {"id": 3}, "junk"])
        self.assertEqual(self.run_async(kavita.user_library_ids(KAVITA, self.TOKEN)), {1, 3})
        self.assertEqual(self.requests[0].headers["authorization"], f"Bearer {self.TOKEN}")

    def test_a_refused_token_is_its_own_error_and_other_failures_are_unavailable(self):
        self.answers["/api/Library/libraries"] = httpx.Response(401)
        with self.assertRaises(kavita.KavitaTokenRefused):
            self.run_async(kavita.user_library_ids(KAVITA, self.TOKEN))
        for answer in (httpx.Response(500), httpx.Response(200, text="not json"), httpx.Response(200, json={"a": 1}),
                       httpx.Response(403), httpx.Response(404),
                       httpx.ConnectError(f"connect failed for {KAVITA}/?apiKey={self.KEY} {self.TOKEN}")):
            self.answers["/api/Library/libraries"] = answer
            with self.subTest(answer=repr(answer)):
                with self.assertRaises(kavita.KavitaUnavailable) as caught:
                    self.run_async(kavita.user_library_ids(KAVITA, self.TOKEN))
                self.assertNotIsInstance(caught.exception, kavita.KavitaTokenRefused)
                self.assertNotIn(self.TOKEN, str(caught.exception))
                self.assertNotIn(self.KEY, str(caught.exception))
                self.assertNotIn("kavita.test", str(caught.exception))

    def test_in_progress_series_asks_kavita_for_started_and_unfinished(self):
        seen = {}

        def answer(request):
            seen["body"] = json.loads(request.content)
            seen["params"] = dict(request.url.params)
            return httpx.Response(200, json=[{"id": 11}, {"id": 12}, {"nope": 1}])

        self.answers["/api/Series/all-v2"] = answer
        self.assertEqual(self.run_async(kavita.in_progress_series_ids(KAVITA, self.TOKEN)), [11, 12])
        statements = seen["body"]["statements"]
        self.assertEqual([(s["field"], s["comparison"], s["value"]) for s in statements],
                         [(20, 1, "0"), (20, 3, "100")])
        self.assertEqual(seen["body"]["combination"], 1)
        self.assertEqual(seen["params"]["PageSize"], "100")

    def test_chapter_places_only_for_chapters_started(self):
        progress = {1: 0, 2: 7, 3: 4}

        def get_progress(request):
            chapter = int(request.url.params["chapterId"])
            if chapter == 9:
                return httpx.Response(404)
            return httpx.Response(200, json={"chapterId": chapter, "pageNum": progress[chapter],
                                             "lastModifiedUtc": "2026-10-01T08:30:00"})

        self.answers["/api/Reader/get-progress"] = get_progress
        self.answers["/api/Series/chapter"] = lambda r: httpx.Response(200, json={"pages": 40})
        places = self.run_async(kavita.chapter_places(KAVITA, self.TOKEN, [1, 2, 3, 9, 2]))
        self.assertEqual(places, {2: {"page": 7, "pages": 40, "at": datetime(2026, 10, 1, 8, 30)},
                                  3: {"page": 4, "pages": 40, "at": datetime(2026, 10, 1, 8, 30)}})
        asked = [r.url.params["chapterId"] for r in self.requests if r.url.path == "/api/Reader/get-progress"]
        self.assertEqual(sorted(asked), ["1", "2", "3", "9"])             # each once
        self.answers["/api/Reader/get-progress"] = httpx.Response(401)
        with self.assertRaises(kavita.KavitaTokenRefused):
            self.run_async(kavita.chapter_places(KAVITA, self.TOKEN, [1, 2]))

    def test_chapter_number_comes_from_the_contents(self):
        toc = [{"title": "Cover", "page": 0, "children": []},
               {"title": "Part One", "page": 1, "children": [
                   {"title": "Chapter 1 - Start", "page": 2, "children": []},
                   {"title": "Chapter 2", "page": 5, "children": []}]},
               {"title": "Chapter 12 - The Middle", "page": 20, "children": []},
               {"title": "Epilogue", "page": 38, "children": []}]
        self.answers["/api/Book/101/chapters"] = httpx.Response(200, json=toc)
        number = lambda page: self.run_async(kavita.chapter_number_at(KAVITA, self.TOKEN, 101, page))
        self.assertEqual((number(2), number(6), number(20), number(30)), (1, 2, 12, 12))
        self.assertIsNone(number(0))                                       # the cover
        self.assertIsNone(number(1))                                       # "Part One"
        self.assertIsNone(number(39))                                      # "Epilogue"
        self.answers["/api/Book/101/chapters"] = httpx.Response(500)       # a nicety, never an error
        self.assertIsNone(number(20))
        self.answers["/api/Book/101/chapters"] = httpx.Response(401)
        self.assertIsNone(number(20))

    def test_cover_is_read_with_the_server_key_and_only_an_image_is_passed_on(self):
        self.answers["/api/image/chapter-cover"] = httpx.Response(200, content=b"\x89PNGdata",
                                                                  headers={"content-type": "image/png"})
        self.assertEqual(self.run_async(kavita.chapter_cover(101)), (b"\x89PNGdata", "image/png"))
        self.assertEqual(self.requests[0].url.params["apiKey"], self.KEY)
        self.assertEqual(self.requests[0].url.params["chapterId"], "101")
        self.assertNotIn("authorization", self.requests[0].headers)

    def test_cover_rejects_non_image_content_and_oversize_bodies(self):
        for content_type in ("text/html", "image/svg+xml", "application/json", "", "text/html; charset=utf-8"):
            self.answers["/api/image/chapter-cover"] = httpx.Response(200, content=b"<script>x</script>",
                                                                      headers={"content-type": content_type})
            with self.subTest(content_type=content_type):
                with self.assertRaises(kavita.KavitaNoCover):
                    self.run_async(kavita.chapter_cover(101))
        self.answers["/api/image/chapter-cover"] = httpx.Response(
            200, content=b"x" * (kavita.COVER_MAX_BYTES + 1), headers={"content-type": "image/jpeg"})
        with self.assertRaises(kavita.KavitaNoCover):
            self.run_async(kavita.chapter_cover(101))
        self.answers["/api/image/chapter-cover"] = httpx.Response(404)
        with self.assertRaises(kavita.KavitaNoCover):
            self.run_async(kavita.chapter_cover(101))

    def test_cover_errors_never_carry_the_key(self):
        for answer in (httpx.Response(500), httpx.ConnectError(f"failed for {KAVITA}/?apiKey={self.KEY}")):
            self.answers["/api/image/chapter-cover"] = answer
            with self.subTest(answer=repr(answer)):
                with self.assertRaises(kavita.KavitaUnavailable) as caught:
                    self.run_async(kavita.chapter_cover(101))
                self.assertNotIn(self.KEY, str(caught.exception))
                self.assertIsNone(caught.exception.__cause__)          # the httpx error's text holds the URL
                if isinstance(answer, httpx.ConnectError):
                    self.assertTrue(caught.exception.__suppress_context__)   # never shown in a traceback


# --- Catalog helpers ------------------------------------------------------------------------

@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Folding(unittest.TestCase):
    def test_fold_and_name_key(self):
        self.assertEqual(book_catalog.fold("  Brontë’s   CAFÉ "), "bronte's cafe")
        self.assertEqual(book_catalog.fold(None), "")
        self.assertEqual(book_catalog.name_key("  J.  R. R.   Tolkien "), "j. r. r. tolkien")
        self.assertNotEqual(book_catalog.name_key("Jose"), book_catalog.name_key("José"))
        self.assertEqual(book_catalog.name_key("José"), book_catalog.name_key("José"))   # NFD input


if __name__ == "__main__":
    unittest.main()
