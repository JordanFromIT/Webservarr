"""
Books: the audiobook notice's answer, kept per account (POST
/api/books/me/notice, book_personal.notice_state / set_notice), and the
Books page render that carries it (main.books_notice into the #ws-data
block, the site's name written into the notice).

What is proven: a person with no answer gets the first-visit window, Okay on
it ("seen") turns later visits into the inline notice, Don't show again
("off") is for good, answers are per identity, the write needs a session,
an identity and a same-origin request, and the page says what to show from
its first byte. Each class has its own in-memory database.
"""
import json
import re
import unittest
from unittest import mock

from app.tests import helpers  # noqa: F401 - sets up the test environment first

try:
    import httpx  # noqa: F401
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

if HAVE_APP:
    # Not in the guard above: a missing module of this work must fail the suite, not skip it.
    from app import main, pages
    from app.services import book_personal

URL = "/api/books/me/notice"
MEMBER = {"user_id": "1001", "username": "listener1001", "display_name": "Listener", "is_admin": "false",
          "auth_method": "plex", "plex_account_id": "1001", "plex_token": "PLEX-TOKEN-1001", "email": ""}
OTHER = dict(MEMBER, user_id="1002", username="listener1002", plex_account_id="1002")
LOCAL = {"user_id": "7", "username": "sam", "is_admin": "false", "auth_method": "simple",
         "account_uid": "uid-7", "email": ""}
NO_IDENTITY = {"user_id": "", "username": "ghost", "is_admin": "false", "auth_method": "plex", "email": ""}


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class NoticeState(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.addCleanup(self.db.close)

    def test_no_answer_is_the_window(self):
        self.assertEqual(book_personal.notice_state(self.db, "plex:1001"), "window")

    def test_seen_is_the_inline_notice_and_off_is_for_good(self):
        self.assertEqual(book_personal.set_notice(self.db, "plex:1001", "seen"), "inline")
        self.assertEqual(book_personal.set_notice(self.db, "plex:1001", "seen"), "inline")     # again: the same
        self.assertEqual(book_personal.set_notice(self.db, "plex:1001", "off"), "off")
        # Another tab's window pressed later never brings it back.
        self.assertEqual(book_personal.set_notice(self.db, "plex:1001", "seen"), "off")
        self.assertEqual(book_personal.notice_state(self.db, "plex:1001"), "off")

    def test_off_without_the_window_first(self):
        self.assertEqual(book_personal.set_notice(self.db, "local:uid-7", "off"), "off")

    def test_per_identity(self):
        book_personal.set_notice(self.db, "plex:1001", "off")
        self.assertEqual(book_personal.notice_state(self.db, "plex:1002"), "window")
        self.assertEqual(book_personal.notice_state(self.db, "local:uid-7"), "window")

    def test_only_the_two_answers(self):
        for bad in ("window", "inline", "", "OFF"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    book_personal.set_notice(self.db, "plex:1001", bad)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class NoticeRoute(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.addCleanup(helpers.reset_overrides)

    def client(self, user):
        return helpers.api_client(self.Session, user, headers=helpers.SAME_ORIGIN)

    def state(self, identity):
        db = self.Session()
        try:
            return book_personal.notice_state(db, identity)
        finally:
            db.close()

    def test_member_okay_then_dont_show_again(self):
        c = self.client(MEMBER)
        r = c.post(URL, json={"state": "seen"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"notice": "inline"})
        self.assertEqual(self.state("plex:1001"), "inline")
        self.assertEqual(c.post(URL, json={"state": "off"}).json(), {"notice": "off"})
        self.assertEqual(c.post(URL, json={"state": "seen"}).json(), {"notice": "off"})
        self.assertEqual(self.state("plex:1001"), "off")
        # Nobody else's answer moved.
        self.assertEqual(self.state("plex:1002"), "window")

    def test_a_local_account_is_its_uid(self):
        self.client(LOCAL).post(URL, json={"state": "off"})
        self.assertEqual(self.state("local:uid-7"), "off")

    def test_signed_out_is_401(self):
        from fastapi import HTTPException

        from app.dependencies import get_current_user
        c = self.client(MEMBER)

        def refuse():
            raise HTTPException(status_code=401, detail="Not signed in")

        main.app.dependency_overrides[get_current_user] = refuse
        self.assertEqual(c.post(URL, json={"state": "off"}).status_code, 401)
        self.assertEqual(self.state("plex:1001"), "window")

    def test_a_session_without_an_identity_keeps_nothing(self):
        self.assertEqual(self.client(NO_IDENTITY).post(URL, json={"state": "off"}).status_code, 403)

    def test_cross_origin_is_refused(self):
        c = helpers.api_client(self.Session, MEMBER)
        self.assertEqual(c.post(URL, json={"state": "off"}).status_code, 403)                     # no Origin
        self.assertEqual(c.post(URL, json={"state": "off"}, headers={"Origin": "https://evil.test"}).status_code, 403)
        self.assertEqual(self.state("plex:1001"), "window")

    def test_only_seen_or_off(self):
        c = self.client(MEMBER)
        for body in ({"state": "inline"}, {"state": "window"}, {"state": 1}, {}, {"state": "\ud800"}):
            with self.subTest(body=body):
                self.assertEqual(c.post(URL, json=body).status_code, 422)
        self.assertEqual(self.state("plex:1001"), "window")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class NoticeOnThePage(unittest.TestCase):
    """main.books_notice: what the Books page render carries for the session."""

    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        p = mock.patch.object(main, "SessionLocal", self.Session)
        p.start()
        self.addCleanup(p.stop)

    def answer(self, identity, state):
        db = self.Session()
        try:
            book_personal.set_notice(db, identity, state)
        finally:
            db.close()

    def test_from_the_account(self):
        self.assertEqual(main.books_notice(MEMBER), "window")
        self.answer("plex:1001", "seen")
        self.assertEqual(main.books_notice(MEMBER), "inline")
        self.assertEqual(main.books_notice(OTHER), "window")
        self.answer("plex:1001", "off")
        self.assertEqual(main.books_notice(MEMBER), "off")

    def test_no_identity_or_no_database_shows_nothing(self):
        self.assertEqual(main.books_notice(NO_IDENTITY), "off")
        with mock.patch.object(main, "SessionLocal", side_effect=RuntimeError("down")), \
                self.assertLogs("app.main", level="WARNING"):
            self.assertEqual(main.books_notice(MEMBER), "off")

    def test_the_books_routes_pass_it_to_the_render(self):
        src = open(main.__file__, encoding="utf-8").read()
        for route in ("async def books_page(", "async def book_page("):
            body = src[src.index(route):]
            body = body[:body.index("\n\n\n")]
            with self.subTest(route=route):
                self.assertIn('"books_notice": books_notice(user)', body)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class NoticeRender(unittest.TestCase):
    """pages.render_html: the data block and the site's name in the notice."""

    PAGE = ('<html><head><title>Books</title></head><body>'
            '<p>listening right here on <span data-books-notice-site>this site</span>.</p></body></html>')

    def render(self, name="books", notice=None, app_name="Riverbend"):
        from app.routers.branding import build_branding
        b = build_branding({"branding.app_name": app_name}, {}, None, {"tickets": None, "issues": None, "playback": None})
        flags = {"books_notice": notice} if notice else {}
        return pages.render_html(self.PAGE, name=name, branding=b, user=None, version="9.9.9",
                                 base_url="https://example.test", path="/books", flags=flags)

    def data(self, out):
        return json.loads(re.search(r'<script id="ws-data" type="application/json">(.*?)</script>', out, re.S).group(1))

    def test_the_data_block_says_what_to_show(self):
        for notice in ("window", "inline", "off"):
            with self.subTest(notice=notice):
                self.assertEqual(self.data(self.render(notice=notice))["books_notice"], notice)
        self.assertNotIn("books_notice", self.data(self.render(name="index")))

    def test_the_site_is_named_from_the_first_paint(self):
        self.assertIn("<span data-books-notice-site>Riverbend</span>", self.render())
        self.assertIn("<span data-books-notice-site>this site</span>", self.render(app_name="   "))
        self.assertIn("<span data-books-notice-site>&lt;b&gt;</span>", self.render(app_name="<b>"))
        # Only on Books.
        self.assertIn("<span data-books-notice-site>this site</span>", self.render(name="index"))

    def test_the_shipped_page_has_the_mark(self):
        with open(pages.STATIC_DIR + "/books.html", encoding="utf-8") as f:
            self.assertIn(pages.BOOKS_NOTICE_SITE, f.read())


if __name__ == "__main__":
    unittest.main()
