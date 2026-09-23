"""
same_origin_path: the one check for "is this a path on our own origin".

Browsers parse URLs by the WHATWG rules: a backslash counts as a slash and
tabs/newlines are dropped anywhere, so "/\\evil.example" and "/\t/evil.example"
pass a naive startswith("/") check yet load from another origin. The helper is
used for the push icon (push.py) and for logo/avatar attributes (pages.py).
"""
import unittest

from app.utils import same_origin_path


class SameOriginPathTests(unittest.TestCase):
    def test_plain_paths_pass(self):
        self.assertEqual(same_origin_path("/static/uploads/logo.png"), "/static/uploads/logo.png")
        self.assertEqual(same_origin_path("  /a/b.png?v=2  "), "/a/b.png?v=2")

    def test_backslash_is_refused(self):
        self.assertEqual(same_origin_path("/\\evil.example"), "")
        self.assertEqual(same_origin_path("/static\\..\\x"), "")

    def test_tab_and_newlines_are_refused(self):
        self.assertEqual(same_origin_path("/\t/evil.example"), "")
        self.assertEqual(same_origin_path("/\r/evil.example"), "")
        self.assertEqual(same_origin_path("/\n/evil.example"), "")
        self.assertEqual(same_origin_path("/a\x00b"), "")
        self.assertEqual(same_origin_path("/a\x7fb"), "")

    def test_protocol_relative_is_refused(self):
        self.assertEqual(same_origin_path("//evil.example/x.png"), "")

    def test_absolute_and_script_urls_are_refused(self):
        self.assertEqual(same_origin_path("https://evil.example/x.png"), "")
        self.assertEqual(same_origin_path("http://evil.example/x.png"), "")
        self.assertEqual(same_origin_path("javascript:alert(1)"), "")
        self.assertEqual(same_origin_path("data:image/png;base64,AAAA"), "")

    def test_non_strings_and_empty(self):
        self.assertEqual(same_origin_path(None), "")
        self.assertEqual(same_origin_path(""), "")
        self.assertEqual(same_origin_path("relative.png"), "")


try:
    from app import pages
    HAVE_PAGES = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_PAGES = False


@unittest.skipUnless(HAVE_PAGES, "app import needs the container's dependencies")
class SafeUrlUsesTheHelper(unittest.TestCase):
    def test_safe_url(self):
        self.assertEqual(pages._safe_url("/static/uploads/logo.png"), "/static/uploads/logo.png")
        self.assertEqual(pages._safe_url("https://cdn.example.com/x.png"), "https://cdn.example.com/x.png")
        self.assertEqual(pages._safe_url("/\\evil.example"), "")
        self.assertEqual(pages._safe_url("/\t/evil.example"), "")
        self.assertEqual(pages._safe_url("javascript:alert(1)"), "")


if __name__ == "__main__":
    unittest.main()
