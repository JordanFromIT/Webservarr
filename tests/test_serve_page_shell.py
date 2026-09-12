import unittest
from app.main import _inject_shell, SHELL_MARKER


class ShellInjectionTest(unittest.TestCase):
    def test_marker_is_replaced_with_partial(self):
        page = f"<body data-page='home'>{SHELL_MARKER}<main></main></body>"
        out = _inject_shell(page)
        self.assertNotIn(SHELL_MARKER, out)
        self.assertIn('id="appSidebar"', out)
        self.assertIn('id="appHeader"', out)

    def test_page_without_marker_is_untouched(self):
        page = "<body><main>login</main></body>"
        self.assertEqual(_inject_shell(page), page)


if __name__ == "__main__":
    unittest.main()
