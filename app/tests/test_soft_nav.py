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

# A page whose module is not named after its file (index.html is Home).
MODULE_NAMES = {"index": "home"}

_SCRIPT_TAG_RE = re.compile(r"<script\b([^>]*)>", re.I)
_TAG_RE = re.compile(r"<[a-zA-Z][^>]*>")
# HTML attribute names are case-insensitive: onClick= runs like onclick=.
_HANDLER_ATTR_RE = re.compile(r"\son[a-z]+\s*=", re.I)
_HANDLER_IN_STRING_RE = re.compile(r"""\bon[a-z]+=\\?["']""", re.I)
_FUNCTION_ARG_RE = re.compile(r"^\s*(?:async\s+)?function\b")


def module_name(name: str) -> str:
    return MODULE_NAMES.get(name, name)


def module_path(name: str):
    return STATIC / "js" / "pages" / f"{module_name(name)}.js"


def module_source(name: str) -> str:
    return module_path(name).read_text(encoding="utf-8")


def attr(attrs: str, key: str):
    m = re.search(r"(?<![\w-])" + key + r'''\s*=\s*["']([^"']*)["']''', attrs, re.I)
    return m.group(1) if m else None


def call_args(code: str, open_at: int) -> list:
    """The top-level arguments of the call whose ( is at open_at, in code-only
    text (strings blanked, so no bracket or comma inside one counts)."""
    args, depth, start = [], 0, open_at + 1
    for i in range(open_at, len(code)):
        c = code[i]
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
            if depth == 0:
                args.append(code[start:i])
                return args
        elif c == "," and depth == 1:
            args.append(code[start:i])
            start = i + 1
    raise AssertionError("unbalanced brackets")


def is_function(arg: str) -> bool:
    """A function expression: `function`, or an arrow (=> outside any bracket)."""
    if _FUNCTION_ARG_RE.match(arg):
        return True
    depth = 0
    for i, c in enumerate(arg):
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == "=" and depth == 0 and arg[i + 1:i + 2] == ">":
            return True
    return False


def has_own_signal(args: list) -> bool:
    """signal is written in the call's own arguments: a nested call's options
    inside the callback's body do not count, nor does a shared options
    variable (the rule is one visible signal per listener)."""
    return any(re.search(r"\bsignal\b", a) for a in args if not is_function(a))


class ConvertedPages(unittest.TestCase):
    def test_converted_pages_have_module_wrapper(self):
        for name in CONVERTED:
            with self.subTest(name):
                h = read(name)
                self.assertEqual(h.count('id="wsPage"'), 1)
                self.assertRegex(
                    h, r'<div id="wsPage" data-ws-module="/static/js/pages/'
                       + re.escape(module_name(name)) + r'\.js\?v=1"')
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
                    self.assertNotRegex(tag, _HANDLER_ATTR_RE, f"{name}: inline handler in {tag[:80]}")
                # HTML the module builds, inside a string or template literal.
                self.assertNotRegex(module_source(name), _HANDLER_IN_STRING_RE, f"{module_name(name)}.js")

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
                    self.assertTrue(has_own_signal(args),
                                    f"{module_name(name)}.js: addEventListener without its own signal: "
                                    f"{code[m.start():m.start() + 80]!r}")

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


# The debug tools (spec 7): a leak checker that wraps addEventListener, the
# timers and fetch, and a page module that throws on purpose. Neither may ever
# load for someone who did not ask for it with ?ws-debug=.
DEBUG_FILES = ("debug-leaks.js", "_debug-throw.js")
_STATIC_IMPORT_RE = re.compile(r"""^\s*import\b[^;(]*?['"][^'"]*debug-leaks\.js""", re.M)
_LITERAL_RE = re.compile(r"""(['"`])([^'"`\n]*debug-leaks\.js[^'"`\n]*)\1""")


class DebugTools(unittest.TestCase):
    def test_debug_code_only_loads_in_debug_mode(self):
        src = (STATIC / "js" / "router.js").read_text(encoding="utf-8")
        self.assertIsNone(_STATIC_IMPORT_RE.search(src), "router.js imports debug-leaks.js statically")
        live = []
        for m in _LITERAL_RE.finditer(src):
            q, body = m.group(1), m.group(2)
            # Inside a comment the stripped source does not end with the blanked literal.
            if not js_code_only(src[:m.end()]).endswith(q + " " * len(body) + q):
                continue
            live.append(m)
            before = js_code_only(src[:m.start()])
            self.assertRegex(before, r"\bimport\s*\(\s*(?:[\w.$]+\s*\(\s*)?$",
                             "debug-leaks.js is named outside a dynamic import(")
            # ...and that import sits in a block entered only in debug mode.
            self.assertRegex(before, r"\bif\s*\([^(){}]*\bdebug\w*[^(){}]*\)\s*\{[^{}]*$",
                             "the debug-leaks.js import is not guarded by the debug check")
        self.assertEqual(len(live), 1, "router.js should import debug-leaks.js in exactly one place")
        self.assertTrue((STATIC / "js" / "debug-leaks.js").is_file())
        self.assertTrue((STATIC / "js" / "pages" / "_debug-throw.js").is_file())

    def test_no_page_or_shell_script_references_the_debug_files(self):
        files = list(STATIC.glob("*.html")) + list((STATIC / "partials").glob("*.html"))
        files += [p for p in (STATIC / "js").rglob("*.js")
                  if p.name not in ("router.js",) + DEBUG_FILES]
        for path in files:
            text = path.read_text(encoding="utf-8")
            for name in DEBUG_FILES:
                self.assertNotIn(name, text, f"{path.relative_to(STATIC)} references {name}")


if __name__ == "__main__":
    unittest.main()
