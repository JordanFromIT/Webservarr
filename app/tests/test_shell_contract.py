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
        js = (STATIC / "js" / "shell.js").read_text(encoding="utf-8")
        for name in ("ready", "whenActive", "poll", "setHTML", "arrive", "swr", "serviceStatus", "clearCache",
                     "dragScroll", "mediaType", "requestStatus"):
            self.assertRegex(js, rf"\b{name}: {name}\b", name)
        # Pages call this to stop a row's momentum glide before scrolling it.
        self.assertIn("dragScroll.stop = function", js)


if __name__ == "__main__":
    unittest.main()
