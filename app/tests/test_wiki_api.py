"""
Wiki category writes, as the category panel on /wiki uses them.

The panel checks the icon name before it sends, but the server is the rule:
an icon that is not a Material Symbols name is refused with 422 on create and
on update, and an empty icon means "no icon". The panel keeps a category's
address by sending its slug back on every edit, and deleting a category keeps
its pages.
"""
import unittest
from unittest import mock

try:
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class CategoryWrites(unittest.TestCase):
    def setUp(self):
        from app.models import WikiCategory, WikiPage

        self.Session = helpers.make_sessionmaker()
        db = self.Session()
        cat = WikiCategory(name="Getting started", slug="getting-started", icon="play_circle", sort_order=0)
        db.add(cat)
        db.commit()
        db.add(WikiPage(title="First steps", slug="first-steps", content="x", content_html="<p>x</p>",
                        category_id=cat.id, published=True))
        db.commit()
        db.close()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        self.client = helpers.api_client(self.Session, helpers.ADMIN)

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()

    def category(self, slug):
        from app.models import WikiCategory
        db = self.Session()
        try:
            row = db.query(WikiCategory).filter(WikiCategory.slug == slug).first()
            return None if row is None else {"name": row.name, "icon": row.icon, "sort_order": row.sort_order}
        finally:
            db.close()

    def test_symbol_names_are_accepted(self):
        for i, name in enumerate(("folder", "play_circle", "looks_3", "a" * 64)):
            r = self.client.post("/api/wiki/categories", json={"name": f"Cat {i}", "icon": name, "sort_order": 10})
            self.assertEqual(r.status_code, 201, (name, r.text))
            self.assertEqual(r.json()["icon"], name)

    def test_no_icon_and_an_empty_icon_both_mean_none(self):
        r = self.client.post("/api/wiki/categories", json={"name": "Plain", "sort_order": 10})
        self.assertEqual((r.status_code, r.json()["icon"]), (201, None))
        r = self.client.post("/api/wiki/categories", json={"name": "Blank", "icon": "", "sort_order": 20})
        self.assertEqual((r.status_code, r.json()["icon"]), (201, None))
        r = self.client.put("/api/wiki/categories/getting-started",
                            json={"name": "Getting started", "slug": "getting-started", "icon": None})
        self.assertEqual((r.status_code, r.json()["icon"]), (200, None))

    BAD = ("Play_Circle", "play-circle", "play circle", " folder", "folder\n", "<b>x</b>",
           "a" * 65, "földer", "folder;")

    def test_other_icons_are_refused_on_create(self):
        for name in self.BAD:
            r = self.client.post("/api/wiki/categories", json={"name": "Bad icon", "icon": name})
            self.assertEqual(r.status_code, 422, (name, r.text))
        self.assertIsNone(self.category("bad-icon"))

    def test_other_icons_are_refused_on_update_and_the_row_is_left_alone(self):
        for name in self.BAD:
            r = self.client.put("/api/wiki/categories/getting-started",
                                json={"name": "Renamed", "slug": "getting-started", "icon": name, "sort_order": 5})
            self.assertEqual(r.status_code, 422, (name, r.text))
        self.assertEqual(self.category("getting-started"),
                         {"name": "Getting started", "icon": "play_circle", "sort_order": 0})

    def test_a_rename_that_sends_the_slug_keeps_the_address(self):
        r = self.client.put("/api/wiki/categories/getting-started",
                            json={"name": "Start here", "slug": "getting-started", "icon": "play_circle",
                                  "description": None, "sort_order": 10})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["slug"], r.json()["name"], r.json()["page_count"]),
                         ("getting-started", "Start here", 1))

    def test_a_clashing_name_answers_409_with_a_message(self):
        r = self.client.post("/api/wiki/categories", json={"name": "Getting Started!", "sort_order": 10})
        self.assertEqual(r.status_code, 409)
        self.assertIn("message", r.json()["detail"])

    def test_deleting_a_category_keeps_its_pages(self):
        from app.models import WikiPage
        r = self.client.delete("/api/wiki/categories/getting-started")
        self.assertEqual(r.json(), {"deleted": "getting-started", "pages_uncategorised": 1})
        db = self.Session()
        try:
            page = db.query(WikiPage).filter(WikiPage.slug == "first-steps").first()
            self.assertIsNotNone(page)
            self.assertIsNone(page.category_id)
        finally:
            db.close()

    def test_members_cannot_write(self):
        member = helpers.api_client(self.Session, helpers.MEMBER)
        self.assertEqual(member.post("/api/wiki/categories", json={"name": "Nope"}).status_code, 403)
        self.assertEqual(member.put("/api/wiki/categories/getting-started",
                                    json={"name": "Nope", "slug": "getting-started"}).status_code, 403)
        self.assertEqual(member.delete("/api/wiki/categories/getting-started").status_code, 403)


if __name__ == "__main__":
    unittest.main()
