"""
Ticket ownership: is_own in every ticket answer, and who may comment.

The ticket page shows its comment box only for `ticket.is_own` (or an
admin), so the API has to say whether the caller owns the ticket. It is
computed on the server from the session, never read from the request.

A ticket's owner is the stable account identity stored as creator_identity
when it was created, never the username: usernames come from separate
namespaces (a local account, a Plex account, an Authentik identity) and can
collide, so a local account named like a Plex user must not see that user's
private tickets. A Plex account is identified by its Plex account id,
whichever way it signed in (Plex directly, or Authentik with its Plex
source), so both sign-ins see the same tickets. A local account is
identified by its own permanent id (users.uid), namespaced so it can never
equal a Plex id.
An empty identity owns nothing, so two sessions that both lack one never
share tickets.

Commenting follows the same rule: the owner or an admin, nobody else. So do
reading a private ticket, listing and counting it, and fetching its images:
every ownership test in the router goes through one check.
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
    from app.routers.tickets import account_identity
    from app.tests.test_push import make_session_factory
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False


def plex(username, plex_id, **extra):
    """A Plex-direct session: user_id is the Plex account id."""
    user = {"username": username, "name": username, "email": "", "is_admin": "false",
            "user_id": plex_id, "plex_account_id": plex_id, "auth_method": "plex",
            "plex_token": "tok-" + plex_id}
    user.update(extra)
    return user


def authentik(username, plex_id, sub="f00dfeed", **extra):
    """An Authentik session through its Plex source: user_id is the OIDC sub,
    the Plex account id was looked up at sign-in."""
    user = {"username": username, "name": username, "email": "", "is_admin": "false",
            "user_id": sub, "plex_account_id": plex_id, "auth_method": "oidc",
            "plex_token": "tok-" + plex_id}
    user.update(extra)
    return user


def local(username, uid, **extra):
    """A local ("simple") account session: account_uid is the account's
    permanent users.uid (its users.id could be reused after a delete)."""
    user = {"username": username, "name": username, "email": "", "is_admin": "false",
            "user_id": uid, "account_uid": uid, "auth_method": "simple"}
    user.update(extra)
    return user


BOB = plex("bob", "123456")
CAROL = plex("carol", "222222")
ADMIN = local("admin", "1", is_admin="true", name="Admin")


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

        self.user = BOB
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
        """A ticket created by the session `creator` (None: no identity)."""
        username = creator["username"] if creator else ""
        db = self.Session()
        try:
            t = Ticket(title="T", description="D", category="other", status="open", is_public=public,
                       creator_username=username, creator_name=username or "Unknown",
                       creator_identity=account_identity(creator) if creator else None,
                       image_path=image_path)
            db.add(t)
            db.commit()
            return t.id
        finally:
            db.close()

    def comments(self, ticket_id):
        db = self.Session()
        try:
            return db.query(TicketComment).filter(TicketComment.ticket_id == ticket_id).all()
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

    def test_a_new_ticket_records_the_creators_identity(self):
        r = self.client.post("/api/tickets", data={"title": "Mine", "description": "D", "category": "other"})
        db = self.Session()
        try:
            t = db.query(Ticket).filter(Ticket.id == r.json()["id"]).one()
            self.assertEqual(t.creator_identity, account_identity(BOB))
            self.assertEqual(t.creator_username, "bob")   # kept for display
        finally:
            db.close()

    def test_another_member_does_not_own_a_public_ticket(self):
        tid = self.add_ticket(BOB, public=True)
        self.as_user(CAROL)
        detail = self.client.get(f"/api/tickets/{tid}").json()
        self.assertIs(detail["is_own"], False)
        listed = self.client.get("/api/tickets").json()["tickets"]
        self.assertEqual([(t["id"], t["is_own"]) for t in listed], [(tid, False)])

    def test_an_admin_does_not_own_a_members_ticket_but_owns_their_own(self):
        theirs = self.add_ticket(BOB)
        mine = self.add_ticket(ADMIN)
        self.as_user(ADMIN)
        self.assertIs(self.client.get(f"/api/tickets/{theirs}").json()["is_own"], False)
        self.assertIs(self.client.get(f"/api/tickets/{mine}").json()["is_own"], True)
        listed = {t["id"]: t["is_own"] for t in self.client.get("/api/admin/tickets").json()["tickets"]}
        self.assertEqual(listed, {theirs: False, mine: True})

    def test_the_same_plex_account_owns_it_from_either_sign_in(self):
        # Plex directly and Authentik (with its Plex source) carry different
        # user ids (the Plex id, the OIDC sub) but the same Plex account id.
        # Authentik's username may even differ from the Plex one.
        tid = self.add_ticket(plex("bob", "123456"))
        for user in (plex("bob", "123456"), authentik("bob", "123456"),
                     authentik("bob-renamed", "123456", sub="another-sub")):
            self.as_user(user)
            detail = self.client.get(f"/api/tickets/{tid}")
            self.assertEqual(detail.status_code, 200, user)
            self.assertIs(detail.json()["is_own"], True, user)
            self.assertEqual([t["id"] for t in self.client.get("/api/tickets").json()["tickets"]], [tid])
            self.assertEqual(self.client.get("/api/tickets/counts").json()["total"], 1)
            r = self.client.post(f"/api/tickets/{tid}/comments", data={"message": "me again"})
            self.assertEqual(r.status_code, 201, (user, r.text))

    def test_a_ticket_made_through_authentik_is_the_plex_sign_ins_too(self):
        self.as_user(authentik("bob", "123456"))
        tid = self.client.post("/api/tickets", data={"title": "T", "description": "D",
                                                     "category": "other"}).json()["id"]
        self.as_user(plex("bob", "123456"))
        self.assertIs(self.client.get(f"/api/tickets/{tid}").json()["is_own"], True)

    def test_a_local_account_with_a_plex_users_name_sees_none_of_their_tickets(self):
        url = self.image("0badc0ffee000001.png")
        tid = self.add_ticket(BOB, image_path=url)
        self.as_user(local("bob", "7"))
        self.assertEqual(self.client.get(f"/api/tickets/{tid}").status_code, 404)
        self.assertEqual(self.client.get("/api/tickets").json()["tickets"], [])
        self.assertEqual(self.client.get("/api/tickets/counts").json()["total"], 0)
        self.assertEqual(self.client.get(url).status_code, 404)
        r = self.client.post(f"/api/tickets/{tid}/comments", data={"message": "hi"})
        self.assertEqual(r.status_code, 403, r.text)

    def test_a_local_account_id_never_equals_a_plex_id(self):
        # Local user 123456 and Plex account 123456 are different people.
        tid = self.add_ticket(plex("bob", "123456"))
        self.as_user(local("someone", "123456"))
        self.assertEqual(self.client.get(f"/api/tickets/{tid}").status_code, 404)
        self.assertNotEqual(account_identity(local("x", "123456")), account_identity(plex("x", "123456")))

    def test_a_plex_user_does_not_see_a_local_namesakes_tickets(self):
        tid = self.add_ticket(local("bob", "7"))
        self.as_user(BOB)
        self.assertEqual(self.client.get(f"/api/tickets/{tid}").status_code, 404)
        self.assertEqual(self.client.get("/api/tickets").json()["tickets"], [])

    def test_the_request_cannot_claim_ownership(self):
        tid = self.add_ticket(BOB, public=True)
        self.as_user(CAROL)
        r = self.client.get(f"/api/tickets/{tid}?is_own=true", headers={"X-Is-Own": "true"})
        self.assertIs(r.json()["is_own"], False)

    def test_an_empty_identity_owns_nothing(self):
        tid = self.add_ticket(None, public=True)
        # An Authentik sign-in whose Plex account could not be looked up has
        # no identity, and neither does a session without a user id.
        for user in (authentik("", "", sub=""), local("", ""), plex("", "")):
            self.as_user(user)
            self.assertEqual(account_identity(user), "", user)
            self.assertIs(self.client.get(f"/api/tickets/{tid}").json()["is_own"], False, user)

    # ---- who may comment ----

    def test_the_owner_may_comment(self):
        tid = self.add_ticket(BOB)
        r = self.client.post(f"/api/tickets/{tid}/comments", data={"message": "hello"})
        self.assertEqual(r.status_code, 201, r.text)
        [c] = self.comments(tid)
        self.assertEqual(c.author_identity, account_identity(BOB))
        self.assertEqual(c.author_username, "bob")   # kept for display

    def test_another_member_may_not_comment_even_on_a_public_ticket(self):
        for public in (False, True):
            tid = self.add_ticket(BOB, public=public)
            self.as_user(CAROL)
            r = self.client.post(f"/api/tickets/{tid}/comments", data={"message": "hi"})
            self.assertEqual(r.status_code, 403, (public, r.text))
            self.assertEqual(self.comments(tid), [])

    def test_an_admin_may_comment_on_any_ticket(self):
        tid = self.add_ticket(BOB)
        self.as_user(ADMIN)
        r = self.client.post(f"/api/tickets/{tid}/comments", data={"message": "on it"})
        self.assertEqual(r.status_code, 201, r.text)

    def test_an_empty_identity_may_not_comment_on_a_ticket_with_no_creator(self):
        tid = self.add_ticket(None, public=True)
        self.as_user(authentik("", "", sub=""))
        r = self.client.post(f"/api/tickets/{tid}/comments", data={"message": "hi"})
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(self.comments(tid), [])

    # ---- comment authors ----

    def add_comment(self, ticket_id, author, username=None, is_admin=False):
        db = self.Session()
        try:
            name = username if username is not None else (author["username"] if author else "")
            db.add(TicketComment(ticket_id=ticket_id, author_username=name, author_name=name or "Someone",
                                 author_identity=account_identity(author) if author else None,
                                 is_admin=is_admin, message="hi"))
            db.commit()
        finally:
            db.close()

    def test_the_author_sees_their_own_name_on_a_comment(self):
        tid = self.add_ticket(BOB, public=True)
        self.add_comment(tid, BOB)
        for user in (BOB, authentik("bob", "123456")):
            self.as_user(user)
            c = self.client.get(f"/api/tickets/{tid}").json()["comments"][0]
            self.assertEqual(c["author_name"], "bob", user)

    def test_a_namesake_does_not_see_the_authors_name(self):
        tid = self.add_ticket(BOB, public=True)
        self.add_comment(tid, BOB)
        self.as_user(local("bob", "7"))
        d = self.client.get(f"/api/tickets/{tid}").json()
        self.assertIsNone(d["creator_username"])
        self.assertIsNone(d["comments"][0]["author_username"])
        self.assertIsNone(d["comments"][0]["author_name"])

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

    def test_an_empty_identity_cannot_read_another_empty_identitys_private_ticket(self):
        url = self.image("0123456789abcdef.png")
        tid = self.add_ticket(None, image_path=url)
        self.as_user(authentik("", "", sub="oidc-sub-2"))
        self.assertEqual(self.client.get(f"/api/tickets/{tid}").status_code, 404)
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(self.client.get("/api/tickets").json()["tickets"], [])
        self.assertEqual(self.client.get("/api/tickets/counts").json()["total"], 0)

    def test_list_and_counts_are_the_callers_own_plus_public(self):
        mine = self.add_ticket(BOB)
        public = self.add_ticket(CAROL, public=True)
        self.add_ticket(CAROL)
        self.add_ticket(local("bob", "7"))
        listed = {t["id"]: t["is_own"] for t in self.client.get("/api/tickets").json()["tickets"]}
        self.assertEqual(listed, {mine: True, public: False})
        self.assertEqual(self.client.get("/api/tickets/counts").json()["total"], 2)

    def test_a_private_image_is_its_owners_and_the_admins_only(self):
        url = self.image("fedcba9876543210.png")
        self.add_ticket(BOB, image_path=url)
        self.assertEqual(self.client.get(url).status_code, 200)
        self.as_user(authentik("bob", "123456"))
        self.assertEqual(self.client.get(url).status_code, 200)
        self.as_user(CAROL)
        self.assertEqual(self.client.get(url).status_code, 404)   # as if it were not there
        self.as_user(ADMIN)
        self.assertEqual(self.client.get(url).status_code, 200)

    def test_a_public_tickets_image_is_everyones(self):
        url = self.image("00112233445566aa.png")
        self.add_ticket(BOB, public=True, image_path=url)
        self.as_user(CAROL)
        self.assertEqual(self.client.get(url).status_code, 200)

    def test_a_comment_image_follows_its_ticket(self):
        url = self.image("aabbccddeeff0011.png")
        tid = self.add_ticket(BOB)
        db = self.Session()
        try:
            db.add(TicketComment(ticket_id=tid, author_username="bob", author_name="bob", is_admin=False,
                                 author_identity=account_identity(BOB), message="see", image_path=url))
            db.commit()
        finally:
            db.close()
        self.assertEqual(self.client.get(url).status_code, 200)
        self.as_user(CAROL)
        self.assertEqual(self.client.get(url).status_code, 404)

    def test_an_empty_identity_sees_no_creator_or_author_names(self):
        tid = self.add_ticket(None, public=True)
        self.add_comment(tid, None, username="")
        self.as_user(authentik("", "", sub=""))
        d = self.client.get(f"/api/tickets/{tid}").json()
        self.assertIsNone(d["creator_username"])
        self.assertIsNone(d["creator_name"])
        self.assertIsNone(d["comments"][0]["author_name"])

    def test_every_ownership_test_in_the_router_is_the_one_check(self):
        import inspect
        import re
        import app.routers.tickets as tickets
        src = inspect.getsource(tickets)
        # Outside the helpers, nothing compares a creator or author with the
        # caller, by username or by identity. (The admin list's creator
        # filter is a search by name, not an ownership test.)
        body = src.split("def _owned_by(", 1)[1].split("\ndef ", 1)[1]
        for name in ("creator_username", "author_username", "creator_identity", "author_identity"):
            self.assertNotRegex(body, rf"\.{name}\s*[!=]=\s*(?:current_)?(?:username|identity)\b", name)
        # And the helpers themselves key on identity, never on username.
        helpers = src.split("def _is_owner(", 1)[1].split("def _ticket_to_dict(", 1)[0]
        self.assertNotRegex(helpers, r"creator_username|author_username")
        self.assertIsNone(re.search(r"_is_owner\([^)]*username", body))


if __name__ == "__main__":
    unittest.main()
