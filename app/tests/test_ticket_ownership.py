"""
Ticket ownership: is_own in every ticket answer, and who may comment.

The ticket page shows its comment box only for `ticket.is_own` (or an
admin), so the API has to say whether the caller owns the ticket. It is
computed on the server from the session, never read from the request. A
ticket's owner is the session username stored as creator_username when it
was created, the same identity the list, detail and comment routes already
use for access: a Plex sign-in and an Authentik sign-in of the same account
carry the same username and see the same tickets. An empty username owns
nothing, so two sessions that both lack one never share tickets.

Commenting follows the same rule: the owner or an admin, nobody else. So do
reading a private ticket, listing and counting it, and fetching its images:
every ownership test in the router goes through one check, so an empty
username owns nothing anywhere.
"""
import os
import shutil
import tempfile
import unittest
from unittest import mock

try:
    from fastapi.testclient import TestClient

    from app.database import get_db
    from app.dependencies import get_current_user
    from app.limiter import limiter
    from app.main import app
    from app.models import Ticket, TicketComment
    from app.tests.test_push import make_session_factory
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False


def member(username, **extra):
    user = {"username": username, "name": username, "email": "", "is_admin": "false",
            "user_id": "id-" + username, "auth_method": "simple"}
    user.update(extra)
    return user


ADMIN = {"username": "admin", "name": "Admin", "email": "", "is_admin": "true",
         "user_id": "1", "auth_method": "simple"}


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TicketOwnership(unittest.TestCase):
    def setUp(self):
        self.Session = make_session_factory()

        def _db():
            db = self.Session()
            try:
                yield db
            finally:
                db.close()

        self.user = member("bob")
        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self._limiter_was = limiter.enabled
        limiter.enabled = False
        setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        setup_patch.start()
        self.addCleanup(setup_patch.stop)
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()
        limiter.enabled = self._limiter_was

    def as_user(self, user):
        self.user = user

    def add_ticket(self, creator, public=False, image_path=None):
        db = self.Session()
        try:
            t = Ticket(title="T", description="D", category="other", status="open", is_public=public,
                       creator_username=creator, creator_name=creator or "Unknown", image_path=image_path)
            db.add(t)
            db.commit()
            return t.id
        finally:
            db.close()

    def comments(self, ticket_id):
        db = self.Session()
        try:
            return db.query(TicketComment).filter(TicketComment.ticket_id == ticket_id).count()
        finally:
            db.close()

    # ---- is_own ----

    def test_the_owner_owns_it_everywhere(self):
        r = self.client.post("/api/tickets", data={"title": "Mine", "description": "D", "category": "other"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertIs(r.json()["is_own"], True)
        tid = r.json()["id"]
        self.assertIs(self.client.get(f"/api/tickets/{tid}").json()["is_own"], True)
        listed = self.client.get("/api/tickets").json()["tickets"]
        self.assertEqual([(t["id"], t["is_own"]) for t in listed], [(tid, True)])

    def test_another_member_does_not_own_a_public_ticket(self):
        tid = self.add_ticket("bob", public=True)
        self.as_user(member("carol"))
        detail = self.client.get(f"/api/tickets/{tid}").json()
        self.assertIs(detail["is_own"], False)
        listed = self.client.get("/api/tickets").json()["tickets"]
        self.assertEqual([(t["id"], t["is_own"]) for t in listed], [(tid, False)])

    def test_an_admin_does_not_own_a_members_ticket_but_owns_their_own(self):
        theirs = self.add_ticket("bob")
        mine = self.add_ticket("admin")
        self.as_user(ADMIN)
        self.assertIs(self.client.get(f"/api/tickets/{theirs}").json()["is_own"], False)
        self.assertIs(self.client.get(f"/api/tickets/{mine}").json()["is_own"], True)
        listed = {t["id"]: t["is_own"] for t in self.client.get("/api/admin/tickets").json()["tickets"]}
        self.assertEqual(listed, {theirs: False, mine: True})

    def test_the_same_account_owns_it_from_either_sign_in(self):
        # Plex directly and Authentik (with its Plex source) both carry the
        # account's username; their user ids differ (Plex id, OIDC sub).
        tid = self.add_ticket("bob")
        for user in (member("bob", auth_method="plex", user_id="123456"),
                     member("bob", auth_method="oidc", user_id="f00dfeed")):
            self.as_user(user)
            self.assertIs(self.client.get(f"/api/tickets/{tid}").json()["is_own"], True, user["auth_method"])

    def test_the_request_cannot_claim_ownership(self):
        tid = self.add_ticket("bob", public=True)
        self.as_user(member("carol"))
        r = self.client.get(f"/api/tickets/{tid}?is_own=true", headers={"X-Is-Own": "true"})
        self.assertIs(r.json()["is_own"], False)

    def test_an_empty_username_owns_nothing(self):
        tid = self.add_ticket("", public=True)
        self.as_user(member(""))
        self.assertIs(self.client.get(f"/api/tickets/{tid}").json()["is_own"], False)

    # ---- who may comment ----

    def test_the_owner_may_comment(self):
        tid = self.add_ticket("bob")
        r = self.client.post(f"/api/tickets/{tid}/comments", data={"message": "hello"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(self.comments(tid), 1)

    def test_another_member_may_not_comment_even_on_a_public_ticket(self):
        for public in (False, True):
            tid = self.add_ticket("bob", public=public)
            self.as_user(member("carol"))
            r = self.client.post(f"/api/tickets/{tid}/comments", data={"message": "hi"})
            self.assertEqual(r.status_code, 403, (public, r.text))
            self.assertEqual(self.comments(tid), 0)

    def test_an_admin_may_comment_on_any_ticket(self):
        tid = self.add_ticket("bob")
        self.as_user(ADMIN)
        r = self.client.post(f"/api/tickets/{tid}/comments", data={"message": "on it"})
        self.assertEqual(r.status_code, 201, r.text)

    def test_an_empty_username_may_not_comment_on_a_ticket_with_no_creator(self):
        tid = self.add_ticket("", public=True)
        self.as_user(member(""))
        r = self.client.post(f"/api/tickets/{tid}/comments", data={"message": "hi"})
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(self.comments(tid), 0)


    # ---- reading, listing and images (the same check everywhere) ----

    def image(self, name):
        """A stored ticket image and the URL the API serves it at."""
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        patch = mock.patch("app.routers.tickets.TICKET_UPLOAD_DIR", d)
        patch.start()
        self.addCleanup(patch.stop)
        with open(os.path.join(d, name), "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n")
        return f"/api/uploads/tickets/{name}"

    def test_an_empty_username_cannot_read_another_empty_usernames_private_ticket(self):
        url = self.image("0123456789abcdef.png")
        tid = self.add_ticket("", image_path=url)
        self.as_user(member("", user_id="oidc-sub-2", auth_method="oidc"))
        self.assertEqual(self.client.get(f"/api/tickets/{tid}").status_code, 404)
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(self.client.get("/api/tickets").json()["tickets"], [])
        self.assertEqual(self.client.get("/api/tickets/counts").json()["total"], 0)

    def test_a_private_image_is_its_owners_and_the_admins_only(self):
        url = self.image("fedcba9876543210.png")
        self.add_ticket("bob", image_path=url)
        self.assertEqual(self.client.get(url).status_code, 200)
        self.as_user(member("carol"))
        self.assertEqual(self.client.get(url).status_code, 404)   # as if it were not there
        self.as_user(ADMIN)
        self.assertEqual(self.client.get(url).status_code, 200)

    def test_a_public_tickets_image_is_everyones(self):
        url = self.image("00112233445566aa.png")
        self.add_ticket("bob", public=True, image_path=url)
        self.as_user(member("carol"))
        self.assertEqual(self.client.get(url).status_code, 200)

    def test_a_comment_image_follows_its_ticket(self):
        url = self.image("aabbccddeeff0011.png")
        tid = self.add_ticket("bob")
        db = self.Session()
        try:
            db.add(TicketComment(ticket_id=tid, author_username="bob", author_name="bob", is_admin=False,
                                 message="see", image_path=url))
            db.commit()
        finally:
            db.close()
        self.assertEqual(self.client.get(url).status_code, 200)
        self.as_user(member("carol"))
        self.assertEqual(self.client.get(url).status_code, 404)

    def test_an_empty_username_sees_no_creator_or_author_names(self):
        tid = self.add_ticket("", public=True)
        db = self.Session()
        try:
            db.add(TicketComment(ticket_id=tid, author_username="", author_name="Someone", is_admin=False,
                                 message="hi"))
            db.commit()
        finally:
            db.close()
        self.as_user(member(""))
        d = self.client.get(f"/api/tickets/{tid}").json()
        self.assertIsNone(d["creator_username"])
        self.assertIsNone(d["creator_name"])
        self.assertIsNone(d["comments"][0]["author_name"])

    def test_every_ownership_test_in_the_router_is_the_one_check(self):
        import inspect
        import app.routers.tickets as tickets
        src = inspect.getsource(tickets)
        # Python comparisons of a creator or author with the caller: only
        # inside the helpers. (SQL filters use the SQL form of the same rule.)
        body = src.split("def _owned_by(", 1)[1].split("\ndef ", 1)[1]
        for name in ("creator_username", "author_username"):
            self.assertNotRegex(body, rf"\.{name}\s*[!=]=\s*(?:current_)?username\b", name)
        self.assertNotRegex(body, r"Ticket\.creator_username\s*==\s*username\b")


if __name__ == "__main__":
    unittest.main()
