"""
The desktop player: the top bar's pill slot, Pop out's module, and the
remote window's page (/player/remote).

The behaviour runs in app/tests/js/player_window.mjs (happy-dom); these pin
the markup and the route it needs.
"""
import re
import unittest

from app.tests.test_shell_contract import STATIC
from app.tests.test_page_gating import HAVE_APP, MEMBER_SESSION, PageRoutesBase

HEADER = (STATIC / "partials" / "shell-header.html").read_text(encoding="utf-8")
SIDEBAR = (STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8")
REMOTE = (STATIC / "player-remote.html").read_text(encoding="utf-8")


def strip_comments(text: str) -> str:
    return re.sub(r"<!--.*?-->", "", text, flags=re.S)


class PillSlot(unittest.TestCase):
    def test_the_pill_sits_left_of_the_bell_and_starts_hidden(self):
        head = strip_comments(HEADER)
        self.assertEqual(head.count('id="wsPlayerPill"'), 1)
        self.assertIn('<div id="wsPlayerPill" hidden></div>', head)
        self.assertLess(head.index('id="wsPlayerPill"'), head.index('title="Notifications"'))


class PopOutModule(unittest.TestCase):
    def test_pop_out_loads_last_of_the_player_modules(self):
        side = strip_comments(SIDEBAR)
        names = re.findall(r'<script type="module" src="/static/js/player/([a-z]+)\.js\?v=1" fetchpriority="low"></script>', side)
        self.assertEqual(names, ["saves", "engine", "ui", "features", "findplace", "safetynet", "popout"])


class RemotePageMarkup(unittest.TestCase):
    def test_no_inline_script_and_its_own_module(self):
        page = strip_comments(REMOTE)
        scripts = re.findall(r"<script\b[^>]*>(.*?)</script>", page, flags=re.S)
        self.assertTrue(all(not s.strip() for s in scripts), "inline script")
        self.assertIn('<script type="module" src="/static/js/player-remote.js?v=1"></script>', page)
        self.assertNotRegex(page, r"\son[a-z]+=")

    def test_it_carries_the_shells_player_modules_in_the_shells_order(self):
        deps = re.findall(r'data-ws-dep="/static/js/player/([a-z]+)\.js\?v=1"', REMOTE)
        side = strip_comments(SIDEBAR)
        shell = re.findall(r'src="/static/js/player/([a-z]+)\.js\?v=1"', side)
        # Pop out is the desktop window's; the remote has no window to pop.
        self.assertEqual(deps, [n for n in shell if n != "popout"])

    def test_no_shell_and_no_tab_bar(self):
        self.assertNotIn("ws:sidebar", REMOTE)
        self.assertNotIn("ws:header", REMOTE)
        self.assertIn('data-shell="hidden"', REMOTE)
        self.assertIn('<div id="wsPlayer" hidden></div>', REMOTE)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class RemotePageRoute(PageRoutesBase):
    def test_signed_out_goes_to_sign_in(self):
        r = self.get("/player/remote", None)
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/login"))

    def test_served_with_stamped_modules(self):
        r = self.get("/player/remote", MEMBER_SESSION)
        self.assertEqual(r.status_code, 200)
        self.assertIn('data-page="player-remote"', r.text)
        self.assertIn('<main id="wsRemote"', r.text)
        self.assertIn('src="/static/js/player-remote.js?v=', r.text)
        self.assertNotIn('player-remote.js?v=1"', r.text)
        for name in ("saves", "engine", "ui", "features", "findplace", "safetynet"):
            self.assertRegex(r.text, rf'data-ws-dep="/static/js/player/{name}\.js\?v=(?!1")[^"]+"', name)
        self.assertIn('id="ws-data"', r.text)

    def test_under_books_gate(self):
        r = self.get("/player/remote", MEMBER_SESSION, {"sidebar.enabled_library": "false"})
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/"))

    def test_the_page_file_is_not_served_raw(self):
        r = self.client.get("/static/player-remote.html", follow_redirects=False)
        self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
