"""
Static contract checks on the page files and shell partials.

The shell is server-rendered from two partials; every app page carries the
two markers and nothing of the old JS-built shell. These guards catch the
regression class where one page is edited and drifts from the rest.
"""
import os
import re
import unittest
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "static"
SHELL_PAGES = ["index", "requests", "requests-embed", "issues", "calendar", "tickets",
               "library", "news", "wiki", "settings"]
BARE_PAGES = ["login", "setup", "reader"]

# The repo is a template; an operator's own branding lives in the database,
# never in these files. Operators can add their own names to the guard without
# committing them: WEBSERVARR_FORBIDDEN_STRINGS="My Server,myserver.example".
FORBIDDEN_STRINGS = [s for s in os.environ.get("WEBSERVARR_FORBIDDEN_STRINGS", "").split(",") if s.strip()]


def read(name: str) -> str:
    return (STATIC / f"{name}.html").read_text(encoding="utf-8")


def js_code_only(src: str) -> str:
    """JavaScript source with comments removed and string contents blanked.

    A small scanner rather than a regex, so a // or /* inside a string (a URL,
    say) is not taken for a comment. Blanking the strings means a name that
    appears only inside quotes cannot satisfy a check either. Assumes no regex
    literals, which shell.js does not use.
    """
    out, i, n = [], 0, len(src)
    while i < n:
        c, nxt = src[i], src[i + 1] if i + 1 < n else ""
        if c == "/" and nxt == "/":
            j = src.find("\n", i)
            i = n if j == -1 else j
        elif c == "/" and nxt == "*":
            j = src.find("*/", i + 2)
            i = n if j == -1 else j + 2
            out.append(" ")
        elif c in "'\"`":
            j = i + 1
            while j < n and src[j] != c:
                j += 2 if src[j] == "\\" else 1
            out.append(c + " " * (j - i - 1) + c)
            i = j + 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def matching_brace(code: str, open_at: int) -> int:
    """Index of the } that closes the { at open_at (in comment-free code)."""
    depth = 0
    for i in range(open_at, len(code)):
        if code[i] == "{":
            depth += 1
        elif code[i] == "}":
            depth -= 1
            if depth == 0:
                return i
    raise AssertionError("unbalanced braces")


class ShellContract(unittest.TestCase):
    def test_shell_pages_carry_both_markers_and_no_js_shell(self):
        for n in SHELL_PAGES:
            h = read(n)
            self.assertEqual(h.count("<!-- ws:sidebar -->"), 1, n)
            self.assertEqual(h.count("<!-- ws:header -->"), 1, n)
            for bad in ("sidebar-root", "header-root", "initSidebar(", "showAdminNav(",
                        "loadSystemStatus(", "loadAppVersion(", "/static/js/sidebar.js",
                        "/static/js/header.js", 'id="scrollDownHint"'):
                self.assertNotIn(bad, h, f"{n}: {bad}")
            self.assertIn("/static/js/shell.js", h, n)
            # auth.js defines checkAuth/escapeHtml; shell.js reads WS_DATA from theme-loader.
            self.assertLess(h.index("/static/js/auth.js"), h.index("/static/js/shell.js"), n)
            self.assertLess(h.index("<title>"), h.index("theme-loader.js"), n)

    def test_bare_pages_do_not_reference_the_shell(self):
        for n in BARE_PAGES:
            h = read(n)
            self.assertNotIn("ws:sidebar", h, n)
            self.assertNotIn("ws:header", h, n)
            self.assertNotIn("shell.js", h, n)

    def test_every_page_links_the_compiled_stylesheet_and_theme_loader(self):
        for p in sorted(STATIC.glob("*.html")):
            h = p.read_text(encoding="utf-8")
            self.assertIn('href="/static/css/app.css?v=', h, p.name)
            self.assertIn('src="/static/js/theme-loader.js?v=', h, p.name)

    def test_partials_keep_the_notification_and_menu_contracts(self):
        strip = lambda text: re.sub(r"<!--.*?-->", "", text, flags=re.S)   # comments describe the contract too
        side = strip((STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8"))
        head = strip((STATIC / "partials" / "shell-header.html").read_text(encoding="utf-8"))
        # notifications.js finds bells by title and anchors to the lg:flex header.
        self.assertEqual(head.count('title="Notifications"'), 1)
        self.assertEqual(side.count('title="Notifications"'), 1)
        self.assertRegex(head, r'<header[^>]*class="[^"]*lg:flex')
        for i in ("desktopSidebar", "desktopNav", "drawerNav", "drawerOverlay", "drawerPanel",
                  "hamburgerBtn", "drawerCloseBtn", "mobileTopBar", "mobileUserMenuBtn",
                  "mobileUserMenuDropdown", "mobileUsername", "mobileRole", "scrollDownHint",
                  "appVersion"):
            self.assertIn(f'id="{i}"', side, i)
        for i in ("appHeader", "systemStatus", "userMenuBtn", "userMenuDropdown",
                  "headerUsername", "headerRole", "headerAvatar"):
            self.assertIn(f'id="{i}"', head, i)
        self.assertNotIn("Loading", head)
        self.assertIn('type="speculationrules"', side)
        # Prerender/prefetch only nav links, never logout or arbitrary anchors.
        self.assertNotIn('"href_matches"', side)

    def test_no_instance_specific_strings(self):
        files = (list(STATIC.glob("*.html")) + list((STATIC / "partials").glob("*.html"))
                 + list((STATIC / "js").glob("*.js")))
        for p in files:
            t = p.read_text(encoding="utf-8")
            for bad in FORBIDDEN_STRINGS:
                self.assertNotIn(bad, t, p.name)
        # Generic guard: every shipped page carries the template's own name.
        for p in STATIC.glob("*.html"):
            m = re.search(r"<title>(.*?)</title>", p.read_text(encoding="utf-8"), re.S)
            self.assertIsNotNone(m, p.name)
            self.assertTrue(m.group(1).strip().startswith("WebServarr - "), f"{p.name}: {m.group(1)!r}")

    def test_polls_go_through_ws_poll(self):
        for n in SHELL_PAGES:
            self.assertNotRegex(read(n), r"\bsetInterval\(", f"{n}: use WS.poll so timers wait for activation")

    def test_shell_js_defines_the_public_api(self):
        code = js_code_only((STATIC / "js" / "shell.js").read_text(encoding="utf-8"))
        # Only the exports object counts: a name mentioned anywhere else in the
        # file (a comment, a string, a local variable) is not an export.
        m = re.search(r"\bwindow\.WS\s*=\s*\{", code)
        self.assertIsNotNone(m, "window.WS = { ... } not found")
        block = code[m.end():matching_brace(code, m.end() - 1)]
        for name in ("ready", "whenActive", "poll", "setHTML", "arrive", "swr", "serviceStatus", "clearCache",
                     "dragScroll", "mediaType", "requestStatus"):
            self.assertRegex(block, rf"\b{name}\s*:\s*{name}\b", name)
        # Pages call this to stop a row's momentum glide before scrolling it.
        self.assertIsNotNone(re.search(r"\bdragScroll\.stop\s*=\s*function\b", code),
                             "dragScroll.stop = function ... not defined (outside comments/strings)")

    def test_js_code_only_ignores_comments_and_strings(self):
        # Guards the helper the API test relies on.
        src = ("var a = 1; // b: b\n/* c: c */ var u = 'http://x/*y*/'; "
               "window.WS = { d: d, /* e: e */ f: f };")
        code = js_code_only(src)
        self.assertNotIn("b: b", code)
        self.assertNotIn("c: c", code)
        self.assertNotIn("e: e", code)
        self.assertNotIn("http", code)
        self.assertIn("d: d", code)
        self.assertIn("f: f", code)

if __name__ == "__main__":
    unittest.main()
