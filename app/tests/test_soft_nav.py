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

from app.tests.test_settings_static import function_body
from app.tests.test_shell_contract import STATIC, js_code_only, matching_brace, read

# Pages converted to soft navigation, in conversion order.
CONVERTED = ["news", "settings"]

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


class SharedShellScripts(unittest.TestCase):
    """ui.js (the toast and dialog) loads once, from the shell, on every shell
    page; the router closes dialogs before a swap; WS.getJSON takes the page's
    signal (Task 4 fix round 1: U1, D1, R2)."""

    def partial(self):
        return (STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8")

    def test_ui_js_loads_once_from_the_shell_before_the_router(self):
        from app.tests.test_shell_contract import BARE_PAGES, SHELL_PAGES
        part = self.partial()
        tags = [m for m in _SCRIPT_TAG_RE.finditer(part) if "/static/js/ui.js" in (attr(m.group(1), "src") or "")]
        self.assertEqual(len(tags), 1, "the shell partial loads ui.js exactly once")
        a = tags[0].group(1)
        # A plain blocking script: page scripts later in <body> read WSUI at load.
        for word in ("defer", "async", "type"):
            self.assertIsNone(re.search(rf"\b{word}\b", a), f"ui.js must not be {word}")
        self.assertLess(tags[0].start(), part.index("/static/js/router.js"))
        for name in SHELL_PAGES + BARE_PAGES:
            with self.subTest(name):
                self.assertNotIn("/static/js/ui.js", read(name), f"{name} loads ui.js itself")

    def test_router_does_not_fetch_ui_js(self):
        code = js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8"))
        src = (STATIC / "js" / "router.js").read_text(encoding="utf-8")
        self.assertNotIn("ensureUI", code)
        self.assertNotIn("requestIdleCallback", code)
        self.assertNotRegex(src, r"""['"`][^'"`]*ui\.js['"`]""")

    def test_dialogs_close_before_the_page_changes(self):
        ui = js_code_only((STATIC / "js" / "ui.js").read_text(encoding="utf-8"))
        close_all = function_body(ui, "closeDialogs")
        self.assertRegex(close_all, r"while \(stack\.length\) \{\s*var d = topDialog\(\);\s*d\.close\(d\.dismiss\);\s*\}")
        self.assertRegex(ui, r"window\.WSUI = \{[^}]*\bcloseDialogs: closeDialogs\b")
        code = js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8"))
        overlays = function_body(code, "closeOverlays")
        self.assertIn("WS.closeChrome()", overlays)
        self.assertIn("window.WSUI.closeDialogs()", overlays)
        # Before the old page is left (the swap), and before a page claims a URL.
        commit = function_body(code, "commit")
        self.assertLess(commit.index("closeOverlays();"), commit.index("leave();"))
        self.assertEqual(len(re.findall(r"(?<!function )\bcloseOverlays\(\);", code)), 2)
        # Nothing closes the chrome alone any more: always with the dialogs.
        self.assertEqual(code.count("WS.closeChrome()"), 1)

    def test_a_dialogs_listeners_end_when_it_closes(self):
        # Opened from a page, they are that page's; closed, they must be gone,
        # or the page's leak check lists them after it is left.
        ui = js_code_only((STATIC / "js" / "ui.js").read_text(encoding="utf-8"))
        confirm = function_body(ui, "confirm")
        self.assertIn("var ends = new AbortController();", confirm)
        self.assertRegex(function_body(confirm, "close"), r"^\s*if \(done\) return;\s*done = true;\s*ends\.abort\(\);")
        # document's keydown and focusin serve the whole dialog stack and are
        # removed when the last dialog closes; the dialog's own three end with it.
        adds = [n for n in re.findall(r"\b(\w+)\.addEventListener\(", confirm) if n != "document"]
        self.assertEqual(sorted(adds), ["cancel", "ok", "overlay"])
        self.assertRegex(function_body(confirm, "close"), r"document\.removeEventListener\('\s*', onKey, true\);")
        self.assertEqual(len(re.findall(r"\}, \{ signal: ends\.signal \}\);", confirm)), 3)

    def test_get_json_takes_the_pages_signal(self):
        shell = js_code_only((STATIC / "js" / "shell.js").read_text(encoding="utf-8"))
        body = function_body(shell, "getJSON")
        self.assertRegex(shell, r"function getJSON\(url, opts\)")
        self.assertRegex(body, r"var signal = opts && opts\.signal \? opts\.signal : undefined;")
        self.assertRegex(body, r"return fetch\(url, signal \? \{ signal: signal \} : undefined\)\.then\(")
        # Aborts are not swallowed: no catch in getJSON, so the page sees AbortError.
        self.assertNotIn(".catch(", body)
        news = js_code_only(module_source("news"))
        self.assertEqual(len(re.findall(r"WS\.getJSON\([^;]*\{ signal: signal \}\)", news)), 2)
        self.assertEqual(len(re.findall(r"\bgetJSON\(", news)), 2, "every News JSON read goes through WS.getJSON")

    def test_a_rate_limited_page_is_never_read_or_reused(self):
        code = js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8"))
        self.assertIn("r.status < 500 && r.status !== 429 &&", function_body(code, "fetchPage"))
        self.assertIn("if (!res || res.status >= 500 || res.status === 429) res = await fetchPage(", code)


class LeaveGuard(unittest.TestCase):
    """A page can hold its visitor (Settings with unsaved changes): the router
    awaits ctx.beforeLeave's guard before it leaves the page, for a link,
    navigate(), Back and Forward (Task 5)."""

    def code(self):
        return js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8"))

    def test_go_asks_the_guard_before_it_fetches(self):
        code = self.code()
        go = function_body(code, "go")
        ask = go.index("verdict = await current.guard(new URL(target.href), { pop: !!opts.pop });")
        self.assertLess(go.index("if (!current) {"), ask, "an unconverted page has no guard to ask")
        self.assertLess(go.index("current.claim(new URL(target.href))"), ask, "an in-page URL is not a leave")
        self.assertLess(ask, go.index("takePrefetch(target.href)"), "asked before any fetch")
        after = go[ask:go.index("takePrefetch(target.href)")]
        self.assertIn("if (token !== navToken) return;", after, "a newer navigation wins over an answer")
        stay = re.search(r"if \(verdict === false\) \{(.*?)\n      \}", after, re.S)
        self.assertIsNotNone(stay)
        # Back or Forward already moved the address bar: a stay puts it back.
        self.assertIn("if (opts.pop) history.replaceState(", stay.group(1))
        self.assertIn("current.url);", stay.group(1))
        self.assertRegex(after, r"if \(verdict === '    '\) \{[^}]*await hardNavigate\(target\.href, token\);")
        self.assertIn("if (verdict === 'hard') {", (STATIC / "js" / "router.js").read_text(encoding="utf-8"))

    def test_a_left_page_asks_nothing(self):
        code = self.code()
        self.assertIn("was.guard = null;", function_body(code, "leave"))
        self.assertRegex(code, r"beforeLeave: function \(guard\) \{\s*if \(!entry\.left\) entry\.guard = ")

    def test_a_fragment_entry_the_browser_made_is_marked(self):
        # Back to it from another page must swap this page back in; a page's
        # own entries (a state of their own) are left alone.
        code = self.code()
        m = re.search(r"window\.addEventListener\('\s+', function \(\) \{\s*if \(!current \|\| !samePage\(location\.href, current\.url\)\) return;"
                      r"\s*current\.url = location\.href;\s*if \(history\.state === null\) history\.replaceState\(\{ ws: 1,", code)
        self.assertIsNotNone(m)

    def test_settings_guards_every_way_out(self):
        page = js_code_only(module_source("settings"))
        self.assertRegex(page, r"ctx\.beforeLeave\(function \(url, how\) \{\s*return Promise\.resolve\(window\.WSSettings\.canLeave\(how\)\)")
        kit = (STATIC / "js" / "settings" / "kit.js").read_text(encoding="utf-8")
        kit_code = js_code_only(kit)
        can = function_body(kit_code, "canLeave")
        self.assertIn("if (S.leaving || !anyDirty()) return true;", can)
        self.assertIn("return askLeave()", can)
        # A link asks too (its listener on document runs before the router's
        # on window), then is followed as it would have been.
        self.assertIn("e.preventDefault();\n      askLeave().then(function (ok) {", kit)
        self.assertIn("if (a.isConnected) a.click();", kit)
        # Yes throws the changes away, so nothing asks twice (beforeunload
        # included) and no preview outlives the page.
        self.assertIn("if (ok) discardAll();", function_body(kit_code, "askLeave"))
        self.assertIn("discardAll();", function_body(kit_code, "end"))
        self.assertIn("signal.addEventListener('     ', end, { once: true });", function_body(kit_code, "init"))


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

    def test_throw_is_taken_only_where_a_swap_is_about_to_happen(self):
        """takeFlag (the gate itself) is covered in app/tests/js/debug_leaks.mjs.
        Here: the one place go() takes it is after every full-navigation exit
        (an unconverted page, decide() saying "hard"), and only a true result
        replaces the module, so a full navigation never spends the flag and no
        visitor without it ever mounts _debug-throw.js."""
        code = js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8"))
        calls = [m.start() for m in re.finditer(r"\btakeThrow\s*\(", code)
                 if not code[:m.start()].rstrip().endswith("function")]
        self.assertEqual(len(calls), 1, "takeThrow() should be called in exactly one place")
        go = code.index("async function go(")
        go_end = matching_brace(code, code.index("{", go))
        at = calls[0]
        self.assertTrue(go < at < go_end, "takeThrow() is called outside go()")
        body = code[go:at]
        for exit_ in ("if (!current)", "if (d.action ===", "await hardNavigate(d.url, token)"):
            self.assertIn(exit_, body, f"takeThrow() is called before the full-navigation exit {exit_!r}")
        self.assertRegex(code[at - 40:at + 80], r"if\s*\(\s*takeThrow\(\)\s*\)\s*moduleUrl\s*=",
                         "only a taken flag may replace the page's module")
        self.assertRegex(code, r"function takeThrow\(\)\s*\{\s*const store = takeFlag\(",
                         "takeThrow() must go through the tested takeFlag() gate")

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
