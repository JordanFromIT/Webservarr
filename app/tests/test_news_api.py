"""
GET /api/news/ draft gating.

The /news page asks for published_only=false when the viewer is an admin, so
admins can see and manage drafts in place. The server, not the page, decides
who gets drafts: a member who sends the same flag still gets published posts
only, and never the editor's `content` copy.
"""
import unittest
from unittest import mock

try:
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class DraftGating(unittest.TestCase):
    user = None

    def setUp(self):
        from app.models import NewsPost

        self.Session = helpers.make_sessionmaker()
        db = self.Session()
        live = NewsPost(title="Live post", content="<p>live</p>", content_html="<p>live</p>",
                        author_id="a", author_name="Admin", published=True)
        draft = NewsPost(title="Draft post", content="<p>draft</p>", content_html="<p>draft</p>",
                         author_id="a", author_name="Admin", published=False)
        db.add_all([live, draft])
        db.commit()
        self.draft_id = draft.id
        db.close()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()

    def titles(self, client, query):
        r = client.get("/api/news/" + query)
        self.assertEqual(r.status_code, 200, r.text)
        return sorted(p["title"] for p in r.json()), r.json()

    def test_a_member_asking_for_drafts_gets_published_posts_only(self):
        client = helpers.api_client(self.Session, helpers.MEMBER)
        titles, posts = self.titles(client, "?published_only=false&limit=21&offset=0")
        self.assertEqual(titles, ["Live post"])
        self.assertTrue(all("content" not in p for p in posts))
        self.assertEqual(client.get(f"/api/news/{self.draft_id}").status_code, 404)

    def test_an_admin_asking_for_drafts_gets_them(self):
        client = helpers.api_client(self.Session, helpers.ADMIN)
        titles, posts = self.titles(client, "?published_only=false&limit=21&offset=0")
        self.assertEqual(titles, ["Draft post", "Live post"])
        self.assertTrue(all("content" in p for p in posts))
        r = client.get(f"/api/news/{self.draft_id}")
        self.assertEqual((r.status_code, r.json()["published"]), (200, False))

    def test_without_the_flag_even_an_admin_gets_published_posts_only(self):
        # The homepage feed omits the flag; an admin's home must not show drafts.
        client = helpers.api_client(self.Session, helpers.ADMIN)
        titles, _ = self.titles(client, "?limit=21")
        self.assertEqual(titles, ["Live post"])


if __name__ == "__main__":
    unittest.main()
