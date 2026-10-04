"""
Books, the personal features (sub-project 3b, task 1): My list, the Up next
queue and star ratings written through to Kavita and Plex
(app/services/book_personal.py, app/routers/book_personal.py).

The routes run end to end on an in-memory catalog, as in test_books_api
(Kavita's and Plex's reads faked at their function boundaries). The
write-through is tested against fake Kavita and Plex writers
(kavita.rate_chapter, plex_player.rate) and the integrations' own writes at
the httpx layer. Concurrent queue moves run on a real SQLite file with
several connections; the merge moves through a real catalog rebuild; the
migration with two real worker processes. No test reaches Kavita, Plex or
the dev instance's data.
"""
import asyncio
import json
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta
from unittest import mock

from app.tests import helpers

try:
    import httpx
    from sqlalchemy import inspect, text
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

if HAVE_APP:
    # Not in the guard above: a missing module of this work must fail the suite, not skip it.
    from app.integrations import kavita
    from app.integrations import plex_player as pp
    from app.models import BookListEntry, BookQueueEntry, BookRating
    from app.services import book_catalog, book_personal
    from app.tests.test_book_catalog import STARTUP_CHILD, CatalogCase, audiobook, ebook, run_together
    from app.tests.test_books_api import A, B, KAVITA, ORIGIN, BooksBase, place, plex_user, when


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class PersonalBase(BooksBase):
    """test_books_api's library: 1 Dune (ebook, editions 10:1 and 11:1), 2 Dune
    Messiah (ebook), 3 Children of Dune (audio 12:1), 4 Emma (ebook), 5 Secret
    Book (an ebook in a library nobody here reaches), 6 Villette (both), 7 The
    Hobbit (audio), 8 Slash Tale (audio), 9 a ghost of 1."""

    def setUp(self):
        super().setUp()
        self.kavita_rate = mock.AsyncMock(return_value=None)
        self.plex_rate = mock.AsyncMock(return_value=None)
        for p in (mock.patch.object(book_personal, "SessionLocal", self.Session),
                  mock.patch.object(kavita, "rate_chapter", self.kavita_rate),
                  mock.patch.object(pp, "rate", self.plex_rate)):
            p.start()
            self.addCleanup(p.stop)

    def send(self, method, path, json_body=None, origin=ORIGIN):
        headers = {"Origin": origin} if origin else {}
        return self.client.request(method, path, json=json_body, headers=headers)

    def done(self, method, path, json_body=None):
        r = self.send(method, path, json_body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def ids(self, body):
        return [i["id"] for i in body["items"]]

    def rating_row(self, identity="plex:1001", book_id=1):
        db = self.Session()
        try:
            row = book_personal.get_rating(db, identity, book_id)
            if row is not None:
                db.expunge(row)
            return row
        finally:
            db.close()


class MyList(PersonalBase):
    def test_add_list_and_remove(self):
        self.assertEqual(self.ok("/api/books/me/list"), {"items": []})
        self.assertEqual(self.done("PUT", "/api/books/4/list"), {"my_list": True})
        self.assertEqual(self.done("PUT", "/api/books/7/list"), {"my_list": True})
        self.assertEqual(self.done("PUT", "/api/books/4/list"), {"my_list": True})   # again: nothing changes
        body = self.ok("/api/books/me/list")
        self.assertEqual(self.ids(body), [7, 4])                                     # newest first
        self.assertEqual(set(body["items"][0]), {"kind", "id", "title", "author", "cover_url", "formats"})
        self.assertEqual(body["items"][0]["formats"], ["audio"])
        self.assertIs(self.ok("/api/books/4")["my_list"], True)
        self.assertIs(self.ok("/api/books/6")["my_list"], False)
        self.assertEqual(self.done("DELETE", "/api/books/4/list"), {"my_list": False})
        self.assertEqual(self.done("DELETE", "/api/books/4/list"), {"my_list": False})   # not on it: fine
        self.assertEqual(self.ids(self.ok("/api/books/me/list")), [7])

    def test_a_book_the_caller_cannot_see_cannot_be_added(self):
        for book_id in (5, 999):                             # another library's ebook, an unknown id
            self.assertEqual(self.send("PUT", f"/api/books/{book_id}/list").status_code, 404)
        self.assertEqual(self.ok("/api/books/me/list")["items"], [])

    def test_a_merged_id_is_the_surviving_book(self):
        self.done("PUT", "/api/books/9/list")
        self.assertEqual(self.ids(self.ok("/api/books/me/list")), [1])
        self.done("DELETE", "/api/books/9/list")
        self.assertEqual(self.ok("/api/books/me/list")["items"], [])

    def test_a_book_out_of_reach_is_hidden_and_comes_back(self):
        self.done("PUT", "/api/books/4/list")
        self.done("PUT", "/api/books/7/list")
        self.reach = set()                                   # Kavita can't be read: no ebooks
        self.assertEqual(self.ids(self.ok("/api/books/me/list")), [7])
        self.reach = {1}
        self.assertEqual(self.ids(self.ok("/api/books/me/list")), [7, 4])

    def test_the_list_is_bounded(self):
        with mock.patch.object(book_personal, "LIST_MAX", 2):
            self.done("PUT", "/api/books/1/list")
            self.done("PUT", "/api/books/4/list")
            self.assertEqual(self.send("PUT", "/api/books/7/list").status_code, 409)
            self.done("PUT", "/api/books/4/list")            # one already on it is fine


class UpNext(PersonalBase):
    def queue(self):
        return [(i["id"], i["position"]) for i in self.ok("/api/books/me/queue")["items"]]

    def test_append_read_and_remove(self):
        self.assertEqual(self.done("PUT", "/api/books/7/queue"), {"queue_position": 0})
        self.assertEqual(self.done("PUT", "/api/books/4/queue"), {"queue_position": 1})
        self.assertEqual(self.done("PUT", "/api/books/1/queue"), {"queue_position": 2})
        self.assertEqual(self.done("PUT", "/api/books/7/queue"), {"queue_position": 0})   # stays where it is
        self.assertEqual(self.queue(), [(7, 0), (4, 1), (1, 2)])
        body = self.ok("/api/books/me/queue")
        self.assertEqual(set(body["items"][0]), {"kind", "id", "title", "author", "cover_url", "formats", "position"})
        self.assertEqual(self.ok("/api/books/1")["queue_position"], 2)
        self.assertIsNone(self.ok("/api/books/6")["queue_position"])
        self.assertEqual(self.done("DELETE", "/api/books/4/queue"), {"queue_position": None})
        self.assertEqual(self.queue(), [(7, 0), (1, 1)])                                   # dense again

    def test_move_up_and_down(self):
        for book_id in (7, 4, 1, 6):
            self.done("PUT", f"/api/books/{book_id}/queue")
        moved = self.done("POST", "/api/books/me/queue/move", {"book_id": 1, "to": 0})
        self.assertEqual([(i["id"], i["position"]) for i in moved["items"]], [(1, 0), (7, 1), (4, 2), (6, 3)])
        self.done("POST", "/api/books/me/queue/move", {"book_id": 1, "to": 1})
        self.assertEqual(self.queue(), [(7, 0), (1, 1), (4, 2), (6, 3)])
        self.done("POST", "/api/books/me/queue/move", {"book_id": 7, "to": 99})        # past the end: the end
        self.assertEqual(self.queue(), [(1, 0), (4, 1), (6, 2), (7, 3)])

    def test_moves_count_only_the_books_the_caller_sees(self):
        for book_id in (7, 4, 1):
            self.done("PUT", f"/api/books/{book_id}/queue")
        self.reach = set()                                    # 4 (an ebook) is hidden now; 1 still has audio
        self.assertEqual(self.queue(), [(7, 0), (1, 1)])
        self.done("POST", "/api/books/me/queue/move", {"book_id": 1, "to": 0})
        self.assertEqual(self.queue(), [(1, 0), (7, 1)])
        self.reach = {1}
        self.assertEqual(self.queue(), [(1, 0), (7, 1), (4, 2)])   # the hidden book kept its place after 7

    def test_moving_a_book_not_queued_or_bad_input(self):
        self.done("PUT", "/api/books/7/queue")
        self.assertEqual(self.send("POST", "/api/books/me/queue/move", {"book_id": 4, "to": 0}).status_code, 404)
        for body in ({"book_id": 7}, {"book_id": 7, "to": -1}, {"book_id": "7", "to": 0}, {"book_id": 0, "to": 0},
                     {"book_id": 7, "to": 1.5}, {"book_id": 7, "to": 10 ** 9}):
            with self.subTest(body=body):
                self.assertEqual(self.send("POST", "/api/books/me/queue/move", body).status_code, 422)

    def test_a_book_the_caller_cannot_see_cannot_be_queued(self):
        self.assertEqual(self.send("PUT", "/api/books/5/queue").status_code, 404)

    def test_the_queue_is_bounded(self):
        with mock.patch.object(book_personal, "QUEUE_MAX", 1):
            self.done("PUT", "/api/books/7/queue")
            self.assertEqual(self.send("PUT", "/api/books/4/queue").status_code, 409)


class NextAudio(PersonalBase):
    def next(self, **params):
        return self.ok("/api/books/me/queue/next-audio", **params)

    def test_the_first_queued_audiobook(self):
        self.assertEqual(self.next(), {"book": None, "edition_key": None})
        for book_id in (4, 7, 1):                             # Emma is an ebook only: never offered
            self.done("PUT", f"/api/books/{book_id}/queue")
        body = self.next()
        self.assertEqual((body["book"]["id"], body["book"]["position"], body["edition_key"]), (7, 1, "14:1"))
        self.assertEqual(body["book"]["title"], "The Hobbit")
        # After a book (its id, or its edition key as the player holds it): the next one.
        self.assertEqual(self.next(after="7")["book"]["id"], 1)
        self.assertEqual(self.next(after="14:1")["book"]["id"], 1)
        self.assertEqual(self.next(after="11:1")["book"]["id"], 7)          # an edition of book 1
        self.assertEqual(self.next(after="99:1")["book"]["id"], 7)          # unknown: nothing skipped
        self.assertEqual(self.next(after="9")["book"]["id"], 7)             # a ghost of 1 is 1

    def test_the_edition_is_the_one_the_book_page_opens(self):
        self.done("PUT", "/api/books/1/queue")
        self.assertEqual(self.next()["edition_key"], "10:1")                 # primary, nothing started
        place(self.db, "plex:1001", "11:1", when(20), book_ms=10, duration=1000)
        self.assertEqual(self.next()["edition_key"], "11:1")                 # the one being listened to
        place(self.db, "plex:1002", "10:1", when(30), book_ms=10, duration=1000)
        self.assertEqual(self.next()["edition_key"], "11:1")                 # someone else's place: not theirs

    def test_no_audio_access_offers_nothing(self):
        self.done("PUT", "/api/books/7/queue")
        self.on.return_value = False
        self.assertEqual(self.next(), {"book": None, "edition_key": None})

    def test_after_is_validated(self):
        for after in ("abc", "1:x", "7;1", "1" * 70):
            with self.subTest(after=after):
                self.assertEqual(self.get("/api/books/me/queue/next-audio", after=after).status_code, 422)

    def test_reading_offers_nothing_changes_the_queue(self):
        self.done("PUT", "/api/books/7/queue")
        self.next()
        self.assertEqual([i["id"] for i in self.ok("/api/books/me/queue")["items"]], [7])


class Ratings(PersonalBase):
    def test_rate_change_and_clear(self):
        self.assertIsNone(self.ok("/api/books/6")["my_rating"])
        self.assertEqual(self.done("PUT", "/api/books/6/rating", {"stars": 4}), {"my_rating": 4})
        self.assertEqual(self.ok("/api/books/6")["my_rating"], 4)
        self.assertEqual(self.done("PUT", "/api/books/6/rating", {"stars": 2}), {"my_rating": 2})
        self.assertEqual(self.ok("/api/books/6")["my_rating"], 2)
        self.assertEqual(self.done("DELETE", "/api/books/6/rating"), {"my_rating": None})
        self.assertIsNone(self.ok("/api/books/6")["my_rating"])
        self.assertIsNone(self.rating_row(book_id=6))                    # cleared everywhere: the row is gone
        self.assertEqual(self.done("DELETE", "/api/books/6/rating"), {"my_rating": None})   # nothing to clear

    def test_stars_are_validated(self):
        for body in ({"stars": 0}, {"stars": 6}, {"stars": "3"}, {"stars": 3.5}, {"stars": True}, {}, None):
            with self.subTest(body=body):
                self.assertEqual(self.send("PUT", "/api/books/6/rating", body).status_code, 422)
        self.assertIsNone(self.rating_row(book_id=6))

    def test_a_book_the_caller_cannot_see_cannot_be_rated(self):
        self.assertEqual(self.send("PUT", "/api/books/5/rating", {"stars": 3}).status_code, 404)
        self.kavita_rate.assert_not_called()


class SameOriginAndIdentity(PersonalBase):
    WRITES = (("PUT", "/api/books/4/list", None), ("DELETE", "/api/books/4/list", None),
              ("PUT", "/api/books/4/queue", None), ("DELETE", "/api/books/4/queue", None),
              ("POST", "/api/books/me/queue/move", {"book_id": 4, "to": 0}),
              ("PUT", "/api/books/4/rating", {"stars": 3}), ("DELETE", "/api/books/4/rating", None))

    def test_every_write_checks_same_origin(self):
        for method, path, body in self.WRITES:
            for origin in (None, "https://evil.example", "null"):
                with self.subTest(method=method, path=path, origin=origin):
                    self.assertEqual(self.send(method, path, body, origin=origin).status_code, 403)
        db = self.Session()
        try:
            self.assertEqual([db.query(m).count() for m in (BookListEntry, BookQueueEntry, BookRating)], [0, 0, 0])
        finally:
            db.close()

    def test_one_persons_rows_are_theirs_alone(self):
        self.done("PUT", "/api/books/4/list")
        self.done("PUT", "/api/books/7/queue")
        self.done("PUT", "/api/books/6/rating", {"stars": 5})
        self.as_user(B)
        self.assertEqual(self.ok("/api/books/me/list")["items"], [])
        self.assertEqual(self.ok("/api/books/me/queue")["items"], [])
        detail = self.ok("/api/books/6")
        self.assertEqual((detail["my_list"], detail["queue_position"], detail["my_rating"]), (False, None, None))
        # B's removals touch nothing of A's.
        self.done("DELETE", "/api/books/4/list")
        self.done("DELETE", "/api/books/7/queue")
        self.done("DELETE", "/api/books/6/rating")
        self.done("PUT", "/api/books/6/rating", {"stars": 1})
        self.as_user(A)
        self.assertEqual(self.ids(self.ok("/api/books/me/list")), [4])
        self.assertEqual(self.ids(self.ok("/api/books/me/queue")), [7])
        self.assertEqual(self.ok("/api/books/6")["my_rating"], 5)
        self.assertEqual(self.rating_row("plex:1002", 6).stars, 1)

    def test_a_session_with_no_identity_owns_nothing(self):
        self.as_user({"user_id": "", "username": "x", "is_admin": "false", "auth_method": "oidc", "email": ""})
        self.assertEqual(self.get("/api/books/me/list").status_code, 403)
        self.assertEqual(self.get("/api/books/me/queue").status_code, 403)
        for method, path, body in self.WRITES:
            with self.subTest(method=method, path=path):
                self.assertIn(self.send(method, path, body).status_code, (403, 404))

    def test_anonymous_is_401(self):
        from app.main import app
        from app.dependencies import get_current_user

        def refuse():
            from fastapi import HTTPException
            raise HTTPException(status_code=401, detail="Not signed in")

        app.dependency_overrides[get_current_user] = refuse
        self.assertEqual(self.get("/api/books/me/list").status_code, 401)
        self.assertEqual(self.send("PUT", "/api/books/4/list").status_code, 401)


class WriteThrough(PersonalBase):
    """Review Focus 5: no Kavita link, or Plex refusing: pending, retried, ok."""

    def test_a_rating_is_written_to_kavita_and_every_plex_edition(self):
        self.done("PUT", "/api/books/1/rating", {"stars": 4})
        self.kavita_rate.assert_awaited_once_with(KAVITA, "jwt-1001", 1101, 101, 4)
        args, kwargs = self.plex_rate.await_args
        self.assertEqual((list(args[1]), args[2]), (["10:1", "11:1"], 8))      # stars x 2, each edition
        self.assertEqual(args[0]["plex_token"], "PLEX-TOKEN-1001")             # as the person
        row = self.rating_row()
        self.assertEqual((row.kavita_state, row.plex_state, row.attempts), ("ok", "ok", 0))

    def test_clearing_writes_the_clear_values(self):
        self.done("PUT", "/api/books/1/rating", {"stars": 4})
        self.done("DELETE", "/api/books/1/rating")
        self.assertEqual(self.kavita_rate.await_args.args[4], 0)
        self.assertEqual(self.plex_rate.await_args.args[2], pp.CLEAR_RATING)
        self.assertIsNone(self.rating_row())

    def test_a_format_with_nothing_to_write_is_ok_without_a_call(self):
        self.done("PUT", "/api/books/4/rating", {"stars": 3})      # an ebook only
        self.plex_rate.assert_not_called()
        self.done("PUT", "/api/books/7/rating", {"stars": 3})      # an audiobook only
        self.assertEqual(self.kavita_rate.await_count, 1)
        self.assertEqual((self.rating_row(book_id=7).kavita_state, self.rating_row(book_id=7).plex_state),
                         ("ok", "ok"))

    def test_no_kavita_link_waits_then_a_visit_with_one_writes_it(self):
        self.as_user(plex_user("1001", kavita_token=""))
        self.done("PUT", "/api/books/6/rating", {"stars": 5})
        self.kavita_rate.assert_not_called()
        row = self.rating_row(book_id=6)
        self.assertEqual((row.kavita_state, row.plex_state, row.attempts), ("pending", "ok", 0))
        self.assertEqual(self.ok("/api/books/6")["my_rating"], 5)      # never blocked or undone
        self.kavita_rate.assert_not_called()
        self.as_user(A)                                                 # linked now
        self.ok("/api/books/6")                                         # the visit tries again
        self.kavita_rate.assert_awaited_once_with(KAVITA, "jwt-1001", 1105, 105, 5)
        self.assertEqual(self.rating_row(book_id=6).kavita_state, "ok")
        self.ok("/api/books/6")
        self.assertEqual(self.kavita_rate.await_count, 1)               # ok: not written again

    def test_a_lapsed_kavita_link_waits_too(self):
        self.kavita_rate.side_effect = kavita.KavitaTokenRefused("Kavita no longer accepts this sign-in")
        self.done("PUT", "/api/books/4/rating", {"stars": 2})
        row = self.rating_row(book_id=4)
        self.assertEqual((row.kavita_state, row.attempts), ("pending", 0))

    def test_plex_refusing_is_pending_then_retried_by_the_loop_then_ok(self):
        self.plex_rate.side_effect = pp.RatingRefused("Plex refused the rating")
        self.done("PUT", "/api/books/7/rating", {"stars": 3})
        row = self.rating_row(book_id=7)
        self.assertEqual((row.plex_state, row.attempts), ("pending", 1))
        self.assertGreater(row.retry_at, datetime.utcnow())
        self.assertEqual(self.ok("/api/books/7")["my_rating"], 3)
        self.assertEqual(self.plex_rate.await_count, 1)                 # a visit waits out the backoff
        redis = FakeRedis({"sid-a": A, "sid-b": B})
        self.assertEqual(asyncio.run(book_personal.retry_due(redis)), 0)  # not due yet
        self.plex_rate.side_effect = None
        self.make_due("plex:1001", 7)
        self.assertEqual(asyncio.run(book_personal.retry_due(redis)), 1)
        self.assertEqual(self.plex_rate.await_args.args[0]["plex_token"], "PLEX-TOKEN-1001")   # A's own session
        self.assertEqual(self.plex_rate.await_args.args[2], 6)
        self.assertEqual(self.rating_row(book_id=7).plex_state, "ok")

    def test_plex_down_counts_and_backs_off_until_it_gives_up(self):
        self.plex_rate.side_effect = pp.PlayerUnavailable("Plex is unavailable")
        self.done("PUT", "/api/books/7/rating", {"stars": 3})
        redis = FakeRedis({"sid-a": A})
        for _ in range(book_personal.MAX_ATTEMPTS - 1):
            self.make_due("plex:1001", 7)
            asyncio.run(book_personal.retry_due(redis))
        row = self.rating_row(book_id=7)
        self.assertEqual((row.plex_state, row.attempts), ("failed:unavailable", book_personal.MAX_ATTEMPTS))
        self.assertIsNone(row.retry_at)
        self.make_due("plex:1001", 7)
        self.assertEqual(asyncio.run(book_personal.retry_due(redis)), 0)     # given up: the loop leaves it
        self.assertEqual([book_personal._backoff(n) for n in (1, 2, 3)], [60, 120, 240])
        # A change of rating starts again.
        self.plex_rate.side_effect = None
        self.done("PUT", "/api/books/7/rating", {"stars": 4})
        row = self.rating_row(book_id=7)
        self.assertEqual((row.plex_state, row.attempts), ("ok", 0))

    def test_the_loop_waits_for_a_person_with_no_session(self):
        self.as_user(plex_user("1001", kavita_token=""))
        self.done("PUT", "/api/books/6/rating", {"stars": 2})
        self.make_due("plex:1001", 6)
        self.assertEqual(asyncio.run(book_personal.retry_due(FakeRedis({"sid-b": B}))), 0)
        self.kavita_rate.assert_not_called()
        # Someone else's linked session is never used for A; A's own is.
        self.assertEqual(asyncio.run(book_personal.retry_due(FakeRedis({"sid-b": B, "sid-a": A}))), 1)
        self.kavita_rate.assert_awaited_once_with(KAVITA, "jwt-1001", 1105, 105, 2)
        self.assertEqual(self.rating_row(book_id=6).kavita_state, "ok")

    def test_the_loop_prefers_a_linked_session_and_skips_one_past_its_lifetime(self):
        self.as_user(plex_user("1001", kavita_token=""))
        self.done("PUT", "/api/books/6/rating", {"stars": 2})
        self.make_due("plex:1001", 6)
        old = dict(A, created_at=str(1))                                  # linked, but past the absolute lifetime
        asyncio.run(book_personal.retry_due(FakeRedis({"sid-old": old, "sid-new": plex_user("1001", kavita_token="")})))
        self.kavita_rate.assert_not_called()
        self.make_due("plex:1001", 6)
        asyncio.run(book_personal.retry_due(FakeRedis({"sid-1": plex_user("1001", kavita_token=""), "sid-2": A})))
        self.kavita_rate.assert_awaited_once()

    def test_a_clear_waiting_for_a_link_keeps_the_row_but_shows_no_rating(self):
        self.done("PUT", "/api/books/6/rating", {"stars": 2})
        self.as_user(plex_user("1001", kavita_token=""))       # the audiobook is still theirs to see
        self.done("DELETE", "/api/books/6/rating")
        self.assertEqual(self.plex_rate.await_args.args[2], pp.CLEAR_RATING)
        row = self.rating_row(book_id=6)
        self.assertEqual((row.stars, row.kavita_state), (None, "pending"))
        self.assertIsNone(self.ok("/api/books/6")["my_rating"])
        self.as_user(A)
        self.ok("/api/books/6")
        self.assertEqual(self.kavita_rate.await_args.args[4], 0)
        self.assertIsNone(self.rating_row(book_id=6))

    def test_a_change_while_writing_is_never_marked_written_with_the_old_value(self):
        async def slow_write(*args):
            # The person changes the rating while Kavita is being written.
            db = self.Session()
            try:
                book_personal.set_rating(db, "plex:1001", 4, 5)
            finally:
                db.close()

        self.kavita_rate.side_effect = slow_write
        self.done("PUT", "/api/books/4/rating", {"stars": 2})
        row = self.rating_row(book_id=4)
        self.assertEqual((row.stars, row.kavita_state), (5, "pending"))
        self.kavita_rate.side_effect = None
        self.ok("/api/books/4")
        self.assertEqual(self.kavita_rate.await_args.args[4], 5)
        self.assertEqual(self.rating_row(book_id=4).kavita_state, "ok")

    def test_a_failure_in_the_write_is_never_an_error_to_the_caller(self):
        self.kavita_rate.side_effect = RuntimeError("boom")
        self.assertEqual(self.done("PUT", "/api/books/4/rating", {"stars": 2}), {"my_rating": 2})
        self.assertEqual(self.rating_row(book_id=4).kavita_state, "pending")

    def test_a_local_account_has_nothing_in_plex(self):
        local = {"user_id": "7", "username": "sam", "is_admin": "false", "auth_method": "simple",
                 "account_uid": "uid-7", "email": "", "kavita_token": "jwt-local", "kavita_base": KAVITA}
        self.as_user(local)
        self.done("PUT", "/api/books/4/rating", {"stars": 2})
        self.plex_rate.assert_not_called()
        self.assertEqual(self.rating_row("local:uid-7", 4).plex_state, "ok")

    def make_due(self, identity, book_id):
        db = self.Session()
        try:
            row = book_personal.get_rating(db, identity, book_id)
            row.retry_at = datetime.utcnow() - timedelta(seconds=1)
            db.commit()
        finally:
            db.close()


class FakeRedis:
    """Just what the retry loop reads: the session hashes."""

    def __init__(self, sessions):
        self.data = {f"session:{sid}".encode(): {k.encode(): str(v).encode() for k, v in s.items()}
                     for sid, s in sessions.items()}

    async def scan_iter(self, match=None, count=None):
        for key in list(self.data):
            yield key

    async def hgetall(self, key):
        return dict(self.data.get(key, {}))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Integrations(unittest.TestCase):
    """The two writes at the httpx layer."""

    def transport(self, handler):
        real = httpx.AsyncClient

        def client(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            return real(*args, **kwargs)
        return mock.patch.object(httpx, "AsyncClient", client)

    def test_kavita_chapter_rating(self):
        seen = []

        def handler(request):
            seen.append(request)
            return httpx.Response(self.status)

        for status, raised in ((200, None), (204, None), (401, kavita.KavitaTokenRefused),
                               (400, kavita.KavitaRefused), (404, kavita.KavitaRefused),
                               (500, kavita.KavitaUnavailable)):
            with self.subTest(status=status), self.transport(handler):
                self.status = status
                if raised:
                    with self.assertRaises(raised):
                        asyncio.run(kavita.rate_chapter(KAVITA, "jwt-x", 1101, 101, 4))
                else:
                    asyncio.run(kavita.rate_chapter(KAVITA, "jwt-x", 1101, 101, 4))
        request = seen[0]
        self.assertEqual((request.method, str(request.url)), ("POST", f"{KAVITA}/api/rating/chapter"))
        self.assertEqual(request.headers["authorization"], "Bearer jwt-x")
        self.assertEqual(json.loads(request.content), {"seriesId": 1101, "chapterId": 101, "userRating": 4})

    def test_kavita_not_answering(self):
        def handler(request):
            raise httpx.ConnectError("down")
        with self.transport(handler), self.assertRaises(kavita.KavitaUnavailable) as caught:
            asyncio.run(kavita.rate_chapter(KAVITA, "jwt-secret", 1, 2, 3))
        self.assertNotIn("jwt-secret", str(caught.exception))

    def test_plex_rate_each_album_once_with_the_listeners_token(self):
        seen = []

        def handler(request):
            seen.append(request)
            return httpx.Response(self.status)

        access = {"token": "SERVER-TOKEN", "uris": {"local": [], "remote": []}}
        admin = {"url": "https://plex.test:32400", "token": "ADMIN", "section": "14"}
        with mock.patch.object(pp, "_configured", return_value=admin), \
                mock.patch.object(pp, "server_access", mock.AsyncMock(return_value=access)), \
                mock.patch.object(pp, "forget_access", mock.AsyncMock()) as forget, \
                self.transport(handler):
            self.status = 200
            asyncio.run(pp.rate({"plex_account_id": "1"}, ["10:1", "10:2", "11:1"], 8))
            self.assertEqual([r.url.params["key"] for r in seen], ["10", "11"])
            self.assertEqual({(r.method, r.url.path, r.url.params["rating"], r.headers["x-plex-token"]) for r in seen},
                             {("PUT", "/:/rate", "8", "SERVER-TOKEN")})
            self.assertNotIn("SERVER-TOKEN", str(seen[0].url))                 # the token is never in the URL
            seen.clear()
            asyncio.run(pp.rate({}, ["10:1"], pp.CLEAR_RATING))
            self.assertEqual(seen[0].url.params["rating"], "-1")
            for status, raised in ((401, pp.TokenRejected), (403, pp.RatingRefused), (500, pp.PlayerUnavailable)):
                with self.subTest(status=status):
                    self.status = status
                    with self.assertRaises(raised):
                        asyncio.run(pp.rate({}, ["10:1"], 2))
            forget.assert_awaited_once()                                       # the 401 drops the cached access
            with self.assertRaises(pp.NotInLibrary):
                asyncio.run(pp.rate({}, ["bad"], 2))
            with self.assertRaises(ValueError):
                asyncio.run(pp.rate({}, ["10:1"], 11))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ConcurrentMoves(unittest.TestCase):
    """Review Focus 2: two tabs (on two workers) reordering one queue."""

    def test_two_writers_keep_positions_dense_unique_and_nothing_lost(self):
        from sqlalchemy import event
        from sqlalchemy.orm import sessionmaker

        from app.database import Base, make_engine

        with tempfile.TemporaryDirectory() as tmp:
            engine = make_engine(f"sqlite:///{tmp}/queue.db", connect_args={"check_same_thread": False,
                                                                           "timeout": 30})
            Base.metadata.create_all(bind=engine)

            # Every read takes a moment, so the two tabs' reads and writes interleave.
            @event.listens_for(engine, "after_cursor_execute")
            def slow_reads(conn, cursor, statement, *args):
                if statement.lstrip().upper().startswith("SELECT"):
                    time.sleep(0.002)

            Session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
            db = Session()
            for book_id in range(1, 11):
                book_personal.enqueue(db, "plex:1", book_id)
            book_personal.enqueue(db, "plex:2", 1)
            db.close()
            errors = []
            start = threading.Barrier(2)

            def tab(seed):
                session = Session()
                try:
                    start.wait()
                    for step in range(60):
                        book_id = (seed * 7 + step * 3) % 10 + 1
                        book_personal.move(session, "plex:1", book_id, (seed + step) % 11, range(1, 11))
                        if step % 10 == seed:
                            book_personal.dequeue(session, "plex:1", [book_id])
                            book_personal.enqueue(session, "plex:1", book_id)
                except Exception as exc:  # noqa: BLE001 - collected and asserted below
                    errors.append(repr(exc))
                finally:
                    session.close()

            threads = [threading.Thread(target=tab, args=(n,)) for n in (1, 2)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=120)
            db = Session()
            try:
                rows = db.query(BookQueueEntry).filter(BookQueueEntry.identity == "plex:1").all()
                other = db.query(BookQueueEntry).filter(BookQueueEntry.identity == "plex:2").all()
            finally:
                db.close()
                engine.dispose()
        self.assertEqual(errors, [])
        self.assertEqual(sorted(r.position for r in rows), list(range(10)))
        self.assertEqual(sorted(r.book_id for r in rows), list(range(1, 11)))
        self.assertEqual([(r.book_id, r.position) for r in other], [(1, 0)])   # another person's untouched


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class MergeMoves(CatalogCase):
    """Review Focus 1: rows follow merged_into, no duplicates, the right row wins."""

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
        self.assertEqual(self.live(), {(7, "10:1"): self.audio_id})
        self.assertEqual(self.book(self.ebook_id).merged_into, self.audio_id)

    def rows(self, model, identity):
        db = self.db()
        try:
            found = db.query(model).filter(model.identity == identity).order_by(model.id).all()
            for r in found:
                db.expunge(r)
            return found
        finally:
            db.close()

    def seed(self, rows):
        db = self.db()
        try:
            db.add_all(rows)
            db.commit()
        finally:
            db.close()

    def test_list_rows_move_and_duplicates_collapse(self):
        t = datetime(2026, 9, 1)
        self.seed([BookListEntry(identity="plex:1", book_id=self.ebook_id, added_at=t),
                   BookListEntry(identity="plex:1", book_id=self.audio_id, added_at=t + timedelta(days=1)),
                   BookListEntry(identity="plex:2", book_id=self.ebook_id, added_at=t)])
        self.merge()
        self.assertEqual([(r.book_id, r.added_at) for r in self.rows(BookListEntry, "plex:1")], [(self.audio_id, t)])
        self.assertEqual([r.book_id for r in self.rows(BookListEntry, "plex:2")], [self.audio_id])

    def test_queue_rows_move_and_the_earlier_place_wins(self):
        t = datetime(2026, 9, 1)
        self.seed([BookQueueEntry(identity="plex:1", book_id=50, position=0, added_at=t),
                   BookQueueEntry(identity="plex:1", book_id=self.ebook_id, position=1, added_at=t),
                   BookQueueEntry(identity="plex:1", book_id=51, position=2, added_at=t),
                   BookQueueEntry(identity="plex:1", book_id=self.audio_id, position=3, added_at=t),
                   BookQueueEntry(identity="plex:2", book_id=self.audio_id, position=0, added_at=t),
                   BookQueueEntry(identity="plex:2", book_id=self.ebook_id, position=1, added_at=t)])
        self.merge()
        self.assertEqual([(r.book_id, r.position) for r in sorted(self.rows(BookQueueEntry, "plex:1"),
                                                                  key=lambda r: r.position)],
                         [(50, 0), (self.audio_id, 1), (51, 2)])
        self.assertEqual([(r.book_id, r.position) for r in self.rows(BookQueueEntry, "plex:2")],
                         [(self.audio_id, 0)])

    def test_the_newer_rating_wins_and_is_written_through_again(self):
        t = datetime(2026, 9, 1)
        self.seed([BookRating(identity="plex:1", book_id=self.ebook_id, stars=2, updated_at=t + timedelta(days=1),
                              kavita_state="ok", plex_state="ok", version=1, attempts=0),
                   BookRating(identity="plex:1", book_id=self.audio_id, stars=5, updated_at=t,
                              kavita_state="ok", plex_state="ok", version=1, attempts=0),
                   BookRating(identity="plex:2", book_id=self.ebook_id, stars=3, updated_at=t,
                              kavita_state="ok", plex_state="ok", version=1, attempts=0),
                   BookRating(identity="plex:3", book_id=self.audio_id, stars=4, updated_at=t + timedelta(days=2),
                              kavita_state="ok", plex_state="ok", version=1, attempts=0),
                   BookRating(identity="plex:3", book_id=self.ebook_id, stars=1, updated_at=t,
                              kavita_state="ok", plex_state="ok", version=1, attempts=0)])
        self.merge()
        one = self.rows(BookRating, "plex:1")
        self.assertEqual([(r.book_id, r.stars) for r in one], [(self.audio_id, 2)])      # the ghost's was newer
        self.assertEqual((one[0].kavita_state, one[0].plex_state), ("pending", "pending"))
        self.assertEqual([(r.book_id, r.stars) for r in self.rows(BookRating, "plex:2")], [(self.audio_id, 3)])
        self.assertEqual([(r.book_id, r.stars) for r in self.rows(BookRating, "plex:3")], [(self.audio_id, 4)])
        self.rebuild()                                                                     # a second rebuild moves nothing
        self.assertEqual([(r.book_id, r.stars) for r in self.rows(BookRating, "plex:1")], [(self.audio_id, 2)])

    def test_a_removed_books_rows_are_kept_hidden_and_its_id_never_goes_to_another_book(self):
        self.sources.audiobooks = [audiobook("10:1", "Dune"), audiobook("20:1", "Emma", author="Jane Austen")]
        self.rebuild()
        emma = self.live()[(None, "20:1")]
        self.seed([BookRating(identity="plex:1", book_id=emma, stars=4, updated_at=datetime(2026, 9, 1),
                              kavita_state="ok", plex_state="ok", version=1, attempts=0),
                   BookListEntry(identity="plex:1", book_id=emma, added_at=datetime(2026, 9, 1))])
        self.sources.audiobooks = [audiobook("10:1", "Dune")]
        self.rebuild()                                                                     # Emma has gone
        self.assertNotIn((None, "20:1"), self.live())
        self.assertEqual([r.book_id for r in self.rows(BookRating, "plex:1")], [emma])    # kept
        self.sources.audiobooks = [audiobook("10:1", "Dune"), audiobook("30:1", "Persuasion", author="Jane Austen")]
        self.rebuild()
        self.assertNotEqual(self.live()[(None, "30:1")], emma)                              # a new book, a new id


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Migration(unittest.TestCase):
    def test_two_workers_starting_at_once_add_the_tables(self):
        from app import models  # noqa: F401 - registers the tables
        from app.database import Base, make_engine

        new_tables = {"book_list", "book_queue", "book_ratings"}
        with tempfile.TemporaryDirectory() as tmp:
            url = f"sqlite:///{tmp}/old.db"
            engine = make_engine(url)
            Base.metadata.create_all(bind=engine, tables=[t for t in Base.metadata.sorted_tables
                                                          if t.name not in new_tables])
            with engine.begin() as conn:
                conn.execute(text("INSERT INTO books (id, title, sort_title, author, series, description, "
                                  "cover_source, updated_at) VALUES (4, 'Kept', '', '', '', '', 'plex', "
                                  "'2026-01-01 00:00:00')"))
            self.assertFalse(new_tables & set(inspect(engine).get_table_names()))
            self.assertEqual(run_together([STARTUP_CHILD, STARTUP_CHILD], url), ["started", "started"])
            run_together([STARTUP_CHILD], url)
            self.assertTrue(new_tables <= set(inspect(engine).get_table_names()))
            uniques = {t: {tuple(u["column_names"]) for u in inspect(engine).get_unique_constraints(t)}
                       for t in new_tables}
            with engine.connect() as conn:
                kept = conn.execute(text("SELECT title FROM books WHERE id = 4")).scalar()
            engine.dispose()
        self.assertEqual(kept, "Kept")
        self.assertIn(("identity", "book_id"), uniques["book_list"])
        self.assertIn(("identity", "book_id"), uniques["book_ratings"])
        self.assertLessEqual({("identity", "book_id"), ("identity", "position")}, uniques["book_queue"])


if __name__ == "__main__":
    unittest.main()
