"""
Soft navigation: the contract every converted page keeps (spec 4.2, 4.3).

A converted page wraps its content in one #wsPage element that names its page
module; the router swaps only that element and runs the module's mount(ctx).
Everything the page does must therefore be undone when its signal aborts, and
nothing may run on its own outside mount. These checks hold each converted
page to that. The list starts empty: each page's conversion appends its name.
"""
import re
import unittest

from app.tests.test_shell_contract import STATIC, js_code_only, read

# Pages converted to soft navigation, in conversion order.
CONVERTED = []

# Loaded once with the shell and never re-run, so a page never declares them.
SHELL_SCRIPTS = {"theme-loader.js", "auth.js", "shell.js", "ui.js", "notifications.js", "router.js"}

_SCRIPT_TAG_RE = re.compile(r"<script\b([^>]*)>", re.I)
_TAG_RE = re.compile(r"<[a-zA-Z][^>]*>")


def module_path(name: str):
    return STATIC / "js" / "pages" / f"{name}.js"


def module_source(name: str) -> str:
    return module_path(name).read_text(encoding="utf-8")


def attr(attrs: str, key: str):
    m = re.search(r"(?<![\w-])" + key + r'''\s*=\s*["']([^"']*)["']''', attrs, re.I)
    return m.group(1) if m else None


def call_args(code: str, open_at: int) -> str:
    """The text between the ( at open_at and the ) that closes it."""
    depth = 0
    for i in range(open_at, len(code)):
        if code[i] == "(":
            depth += 1
        elif code[i] == ")":
            depth -= 1
            if depth == 0:
                return code[open_at + 1:i]
    raise AssertionError("unbalanced parentheses")


class ConvertedPages(unittest.TestCase):
    def test_converted_pages_have_module_wrapper(self):
        for name in CONVERTED:
            with self.subTest(name):
                h = read(name)
                self.assertEqual(h.count('id="wsPage"'), 1)
                self.assertRegex(
                    h, r'<div id="wsPage" data-ws-module="/static/js/pages/' + re.escape(name) + r'\.js\?v=1"')
                self.assertTrue(module_path(name).is_file(), f"{name}: no page module")

    def test_converted_pages_have_no_inline_script(self):
        for name in CONVERTED:
            with self.subTest(name):
                for m in _SCRIPT_TAG_RE.finditer(read(name)):
                    attrs = m.group(1)
                    if attr(attrs, "src"):
                        continue
                    self.assertIn(attr(attrs, "type"), ("application/json", "speculationrules"),
                                  f"{name}: inline <script{attrs}>")

    def test_converted_pages_have_no_inline_handlers(self):
        for name in CONVERTED:
            with self.subTest(name):
                for tag in _TAG_RE.findall(read(name)):
                    self.assertNotRegex(tag, r"\son[a-z]+\s*=", f"{name}: inline handler in {tag[:80]}")
                # HTML the module builds, inside a string or template literal.
                self.assertNotRegex(module_source(name), r"""\bon[a-z]+=\\?["']""", f"{name}.js")

    def test_modules_follow_the_contract(self):
        for name in CONVERTED:
            with self.subTest(name):
                src = module_source(name)
                code = js_code_only(src)
                self.assertNotIn("setInterval(", code, "intervals go through ctx.poll")
                # The event name is a string, which js_code_only blanks: look for it quoted.
                self.assertNotRegex(src, r"""['"`]DOMContentLoaded['"`]""")
                self.assertNotRegex(code, r"\bwindow\.onload\b")
                self.assertRegex(code, r"\bexport\s+(async\s+)?function\s+mount\s*\(")
                for m in re.finditer(r"\baddEventListener\s*\(", code):
                    args = call_args(code, m.end() - 1)
                    self.assertIn("signal", args, f"{name}.js: addEventListener without signal")

    def test_page_helpers_are_declared(self):
        for name in CONVERTED:
            with self.subTest(name):
                for m in _SCRIPT_TAG_RE.finditer(read(name)):
                    src = attr(m.group(1), "src") or ""
                    if not src.startswith("/static/js/"):
                        continue
                    base = src.split("?")[0].rsplit("/", 1)[-1]
                    if base in SHELL_SCRIPTS:
                        continue
                    self.assertRegex(m.group(1), r"\bdata-ws-page-script\b",
                                     f"{name}: {src} is a page helper without data-ws-page-script")


if __name__ == "__main__":
    unittest.main()
