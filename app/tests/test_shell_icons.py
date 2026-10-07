"""
The shell's Material Symbols icons are never read aloud.

An icon is a font ligature: its text is the icon's name ("home", "logout"),
so a screen reader says it before the label beside it ("home Home"). Every
icon the shell draws (the sidebar links, the header, the phone top bar, the
tab bar, the More sheet, the Settings tab strip) is aria-hidden, itself or
through a hidden ancestor. A link or button whose only content is an icon
keeps a name of its own (aria-label), so hiding the icon never leaves it
nameless.
"""
import os
import unittest
from html.parser import HTMLParser

from app import pages
from app.tests.test_pages import ADMIN, MEMBER, branding, render, static_text

ICON_CLASS = "material-symbols-outlined"
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


def setUpModule():
    pages.STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")


class IconScan(HTMLParser):
    """Collects the icons (and the links and buttons holding them) inside the
    subtrees whose ids are in `roots` (the whole document when None)."""

    def __init__(self, roots=None):
        super().__init__(convert_charrefs=True)
        self.roots = roots
        self.stack = []
        self.icons = []      # (ligature, hidden)
        self.controls = []   # {"tag", "label", "text", "icons"}

    def _top(self, key, default=None):
        return self.stack[-1][key] if self.stack else default

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        classes = (a.get("class") or "").split()
        frame = {
            "tag": tag,
            "hidden": self._top("hidden", False) or a.get("aria-hidden") == "true",
            "scoped": self._top("scoped", self.roots is None) or a.get("id") in (self.roots or ()),
            "control": self._top("control"),
            "icon": None,
        }
        if frame["scoped"] and tag in ("a", "button"):
            frame["control"] = {"tag": tag, "label": a.get("aria-label") or a.get("aria-labelledby") or "",
                                "text": "", "icons": 0}
            self.controls.append(frame["control"])
        if frame["scoped"] and ICON_CLASS in classes:
            frame["icon"] = {"ligature": "", "hidden": frame["hidden"]}
            self.icons.append(frame["icon"])
            if frame["control"] is not None:
                frame["control"]["icons"] += 1
        elif self.stack and self.stack[-1]["icon"] is not None:
            frame["icon"] = self.stack[-1]["icon"]
        if tag not in VOID:
            self.stack.append(frame)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.stack.pop()

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i]["tag"] == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        if not self.stack:
            return
        top = self.stack[-1]
        if top["icon"] is not None:
            top["icon"]["ligature"] += data.strip()
        elif top["control"] is not None and not top["hidden"]:
            top["control"]["text"] += data


def scan(out, roots=None):
    s = IconScan(roots)
    s.feed(out)
    s.close()
    return s


class ShellIcons(unittest.TestCase):
    def assert_icons_silent(self, s, where):
        self.assertTrue(s.icons, f"{where}: no icons found, so the scan is not looking at the shell")
        spoken = [i["ligature"] for i in s.icons if not i["hidden"]]
        self.assertEqual(spoken, [], f"{where}: icons a screen reader would read out")
        for c in s.controls:
            if c["icons"]:
                self.assertTrue(c["label"].strip() or c["text"].strip(),
                                f"{where}: a {c['tag']} holding only an icon has no name")

    def test_every_shell_icon_is_hidden_for_each_user_and_page(self):
        for user in (ADMIN, MEMBER):
            for name in ("index", "books", "settings"):
                with self.subTest(user=user["username"], page=name):
                    self.assert_icons_silent(scan(render(user=user, name=name)), f"{user['username']} on {name}")

    def test_the_icon_box_standing_in_for_a_logo_is_hidden(self):
        out = render(b=branding(**{"branding.logo_url": ""}))
        s = scan(out)
        self.assertIn(pages._REGISTRY["icon.sidebar_logo"].default, [i["ligature"] for i in s.icons])
        self.assert_icons_silent(s, "no logo")

    def test_the_settings_tab_strip(self):
        out = render(name="settings", page=static_text("settings.html"))
        s = scan(out, roots={"settingsTabs", "settingsTabHintLeft", "settingsTabHintRight"})
        self.assert_icons_silent(s, "Settings tab strip")


if __name__ == "__main__":
    unittest.main()
