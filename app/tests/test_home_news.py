"""
Home's news cards, written into the page by the server (app/home_news.py).

On a phone News sits above Service Health, so the section must be its real
height from the first paint. The server writes the cards pages/home.js would
write, for the posts it would read; these tests hold the markup to the shared
cases (news_card_vectors.json, which app/tests/js/news_cards.mjs holds
renderNewsCard to, in the CI job js-checks), the posts to the news API's
rules, and the page render to filling the section only when it has them.
"""
import json
import re
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

try:
    from app import home_news
    from app.tests import helpers
    from app.tests.test_pages import ADMIN, branding, render, static_text
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False

TESTS = Path(__file__).resolve().parent
VECTORS = json.loads((TESTS / "news_card_vectors.json").read_text(encoding="utf-8"))


def _post(p):
    return dict(p, created_at=datetime.fromisoformat(p["created_at"][:-1]))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SharedCases(unittest.TestCase):
    def test_every_card(self):
        for c in VECTORS["cases"]:
            with self.subTest(c["why"]):
                self.assertEqual(home_news.render_news_card(_post(c["post"]), VECTORS["now_ms"]), c["html"])

    def test_every_list_and_the_empty_state(self):
        for c in VECTORS["lists"]:
            with self.subTest(c["why"]):
                self.assertEqual(home_news.render_home_news([_post(p) for p in c["posts"]], c["count"],
                                                            VECTORS["now_ms"]), c["html"])
        self.assertEqual(home_news.NEWS_EMPTY_HTML, VECTORS["empty_html"])

    def test_the_cases_cover_what_can_drift(self):
        whys = " | ".join(c["why"] for c in VECTORS["cases"] + VECTORS["lists"])
        for topic in ("new post", "collapsed", "pinned", "escaping", "spaces", "emoji", "140", "trimmed",
                      "just now", "minutes", "clock behind", "three days", "six days", "the date",
                      "empty body", "markup", "empty state", "count + 1", "count of one"):
            self.assertIn(topic, whys)

    def test_text_is_escaped_and_the_body_is_the_sanitised_html(self):
        now = VECTORS["now_ms"]
        card = home_news.render_news_card({"title": '<img src=x onerror=alert(1)>', "content_html": "<p>ok</p>",
                                           "created_at": datetime(2020, 1, 1), "pinned": False}, now)
        self.assertIn("&lt;img src=x onerror=alert(1)&gt;", card)
        self.assertNotIn("<img", card)
        # The excerpt is text: markup in the body never reaches it as markup.
        self.assertIn('line-clamp-2 min-h-10">&lt;b&gt;</p>', home_news.render_news_card(
            {"title": "t", "content_html": "<p>&lt;b&gt;</p>", "created_at": datetime(2020, 1, 1),
             "pinned": False}, now))


class TheJavaScriptSideRuns(unittest.TestCase):
    def test_the_check_reads_the_shared_cases_and_the_real_functions(self):
        js = (TESTS / "js" / "news_cards.mjs").read_text(encoding="utf-8")
        for needle in ("news_card_vectors.json", "static/js/pages/home.js", "const NEWS_FRESH_MS",
                       "function toggleNewsCard(", "static/js/auth.js", "process.exit(failed ? 1 : 0)"):
            self.assertIn(needle, js)
        home = (TESTS.parent / "static" / "js" / "pages" / "home.js").read_text(encoding="utf-8")
        self.assertIn("WS.setHTML(newsContainer, NEWS_EMPTY_HTML);", home)
        self.assertLess(home.index("const NEWS_FRESH_MS"), home.index("function renderNewsCard("))
        self.assertLess(home.index("function renderNewsCard("), home.index("\nfunction toggleNewsCard("))
        pkg = (TESTS.parent.parent / "package.json")
        if pkg.exists():   # the repo, not the image
            self.assertIn("node app/tests/js/news_cards.mjs", pkg.read_text(encoding="utf-8"))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ThePostsAreTheApis(unittest.TestCase):
    """load_home_news reads what GET /api/news/?limit=count+1&max_age_days=N
    returns to the page script, for any signed-in person."""

    def setUp(self):
        from app.models import NewsPost

        self.Session = helpers.make_sessionmaker()
        db = self.Session()
        rows = [
            ("Draft", False, False, timedelta(hours=1)),
            ("Fresh", True, False, timedelta(hours=2)),
            ("Week", True, False, timedelta(days=7)),
            ("Month-and-a-bit", True, False, timedelta(days=35)),
            ("Pinned old", True, True, timedelta(days=60)),
            ("Ten days", True, False, timedelta(days=10)),
            ("Unsafe", True, False, timedelta(days=12)),
        ]
        for title, published, pinned, ago in rows:
            html = '<p onclick="x()">hi<script>bad()</script></p>' if title == "Unsafe" else "<p>%s</p>" % title
            db.add(NewsPost(title=title, content=html, content_html=html, author_id="a", author_name="A",
                            published=published, pinned=pinned, created_at=datetime.utcnow() - ago))
        db.commit()
        db.close()
        self.patch = mock.patch("app.database.SessionLocal", self.Session)
        self.patch.start()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()

    def tearDown(self):
        self.patch.stop()
        self.setup_patch.stop()
        helpers.reset_overrides()

    def api_titles(self, user, count, age):
        client = helpers.api_client(self.Session, user)
        q = f"?limit={count + 1}" + (f"&max_age_days={age}" if age else "")
        r = client.get("/api/news/" + q)
        self.assertEqual(r.status_code, 200, r.text)
        return [p["title"] for p in r.json()]

    def test_the_same_posts_as_the_api_for_admin_and_member(self):
        for count, age in ((3, 30), (1, 30), (5, 0), (10, 30), (2, 9)):
            b = branding(**{"news.homepage_count": str(count), "news.homepage_max_age_days": str(age)})
            got = home_news.load_home_news(b)
            self.assertEqual(got["count"], count)
            titles = [p["title"] for p in got["posts"]]
            for user in (helpers.ADMIN, helpers.MEMBER):
                with self.subTest(count=count, age=age, admin=user is helpers.ADMIN):
                    self.assertEqual(titles, self.api_titles(user, count, age))
            self.assertNotIn("Draft", titles)

    def test_nothing_is_read_when_the_section_is_off(self):
        b = branding(**{"home.section_news": "false"})
        with mock.patch("app.database.SessionLocal", side_effect=AssertionError("read")):
            self.assertIsNone(home_news.load_home_news(b))

    def test_a_database_that_cannot_answer_leaves_the_skeleton(self):
        with mock.patch("app.database.SessionLocal", side_effect=RuntimeError("down")):
            self.assertIsNone(home_news.load_home_news(branding()))

    def test_the_body_is_sanitised_again(self):
        b = branding(**{"news.homepage_count": "10"})
        body = [p for p in home_news.load_home_news(b)["posts"] if p["title"] == "Unsafe"][0]["content_html"]
        self.assertNotIn("onclick", body)
        self.assertNotIn("<script", body)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ThePageRender(unittest.TestCase):
    page = None

    def setUp(self):
        self.page = static_text("index.html")

    def out(self, news):
        flags = {} if news is None else {"home_news": news}
        return render(ADMIN, "index", flags=flags, page=self.page)

    def news_section(self, out):
        start = out.index('<section data-arrive="news"')
        return out[start:out.index("</section>", start)]

    def test_the_skeleton_stays_when_the_server_has_no_news(self):
        section = self.news_section(self.out(None))
        self.assertIn('<div class="skel rounded-xl', section)
        self.assertIn('<section data-arrive="news" class="lg:order-3">', section)
        self.assertIn('id="newsViewAll" class="invisible ', section)

    def test_the_cards_replace_the_skeleton(self):
        case = VECTORS["lists"][2]
        news = {"posts": [_post(p) for p in case["posts"]], "count": case["count"], "now_ms": VECTORS["now_ms"]}
        out = self.out(news)
        section = self.news_section(out)
        self.assertIn('<div id="newsContainer" class="grid gap-3">\n' + case["html"] + "\n</div>", section)
        self.assertNotIn('class="skel', section)
        self.assertNotIn("ws:home-news", out)
        self.assertIn('<section data-arrive="news" class="lg:order-3" data-arrived>', section)
        self.assertIn('id="newsViewAll" class="inline-flex', section)

    def test_no_posts_is_the_empty_state(self):
        section = self.news_section(self.out({"posts": [], "count": 3, "now_ms": VECTORS["now_ms"]}))
        self.assertIn(VECTORS["empty_html"], section)
        self.assertIn('class="lg:order-3" data-arrived>', section)

    def test_only_home_is_filled(self):
        out = render(ADMIN, "news", flags={"home_news": {"posts": [], "count": 3, "now_ms": 0}},
                     page=self.page)
        self.assertNotIn(VECTORS["empty_html"], out)

    def test_the_markers_hold_only_the_skeleton(self):
        inner = re.search(r"<!-- ws:home-news -->(.*?)<!-- /ws:home-news -->", self.page, re.S).group(1)
        self.assertEqual(inner.count('<div class="skel rounded-xl'), 2)
        self.assertNotIn("<section", inner)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TheRoute(unittest.TestCase):
    def test_home_passes_the_news_as_a_function_of_the_branding(self):
        from app import main

        src = Path(main.__file__).read_text(encoding="utf-8")
        self.assertIn('"home_news": _home_news', src)
        with mock.patch("app.home_news.load_home_news", return_value={"posts": [], "count": 3}):
            got = main._home_news(branding())
        self.assertIsInstance(got["now_ms"], int)
        with mock.patch("app.home_news.load_home_news", return_value=None):
            self.assertIsNone(main._home_news(branding()))


if __name__ == "__main__":
    unittest.main()
