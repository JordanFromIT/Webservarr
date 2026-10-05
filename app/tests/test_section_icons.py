"""
Section heading icons (ui.section_icons): the icon before a section heading,
such as Home's Service Health or News & Updates, is a setting that ships off.

The server marks <html data-section-icons> only while it is on, and one rule in
theme.css hides every .ws-section-icon without that mark, so the first paint is
already right and a soft navigation (which copies <html>'s data- attributes)
keeps it in step. These tests pin the default, the registry, seeding and the
branding payload in step, the renderer's mark, the one CSS rule, and which
icons carry the class.
"""
import os
import re
import unittest

from app import pages
from app import settings_registry as reg
from app.tests import helpers
from app.tests.test_pages import branding, css_rules, html_tag, render, static_text

KEY = "ui.section_icons"
STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")
# Every section heading icon: Home's five sections (#iconSection*) and its
# Continue row, both the skeleton in index.html and the row books.js builds.
HOME_SECTION_ICON_IDS = ("iconSectionServices", "iconSectionRequests", "iconSectionNews",
                         "iconSectionStreams", "iconSectionReleases")


def setUpModule():
    pages.STATIC_DIR = STATIC


class Setting(unittest.TestCase):
    def test_registry_ships_it_off(self):
        d = reg.REGISTRY[KEY]
        self.assertEqual((d.type, d.default, d.public, d.seed, d.secret), ("bool", "false", True, True, False))
        self.assertIsNone(reg.validate_value(KEY, "true"))
        self.assertIsNone(reg.validate_value(KEY, "false"))
        self.assertEqual(reg.validate_value(KEY, "yes"), "Must be on or off")

    def test_seed_and_branding_defaults_are_the_registrys(self):
        from app import seed
        from app.routers import branding as branding_router
        self.assertEqual(seed.DEFAULT_SETTINGS[KEY][0], "false")
        self.assertEqual(branding_router.DEFAULTS[KEY], "false")

    def test_seeding_inserts_it_off_and_never_overwrites(self):
        from app.seed import seed_default_settings
        db = helpers.make_sessionmaker()()
        try:
            seed_default_settings(db)
            self.assertEqual(helpers.get(db, KEY), "false")
            helpers.put(db, KEY, "true")
            seed_default_settings(db)
            self.assertEqual(helpers.get(db, KEY), "true")
        finally:
            db.close()

    def test_payload_is_off_unless_exactly_true(self):
        self.assertIs(branding()["section_icons"], False)
        self.assertIs(branding(**{KEY: "true"})["section_icons"], True)
        for odd in ("false", "True", " true", "1", ""):
            self.assertIs(branding(**{KEY: odd})["section_icons"], False, odd)


class Rendering(unittest.TestCase):
    PAGES = ("index", "calendar", "requests", "books", "settings", "login")

    def test_no_mark_by_default(self):
        for name in self.PAGES:
            self.assertNotIn("data-section-icons", html_tag(render(name=name)), name)

    def test_mark_on_every_page_while_on(self):
        b = branding(**{KEY: "true"})
        for name in self.PAGES:
            self.assertIn(" data-section-icons", html_tag(render(name=name, b=b)), name)

    def test_payload_carries_it_for_the_client(self):
        from app.tests.test_pages import data_of
        self.assertIs(data_of(render())["branding"]["section_icons"], False)
        self.assertIs(data_of(render(b=branding(**{KEY: "true"})))["branding"]["section_icons"], True)


class Css(unittest.TestCase):
    def test_one_rule_hides_the_icons_without_the_mark(self):
        css = static_text("css", "theme.css")
        rules = css_rules(css)
        self.assertEqual(rules.get("html:not([data-section-icons]) .ws-section-icon"), {"display": "none"})
        # Nothing else in theme.css styles the icons or keys on the mark.
        selectors = [s for s in rules if "ws-section-icon" in s or "data-section-icons" in s]
        self.assertEqual(selectors, ["html:not([data-section-icons]) .ws-section-icon"])

    def test_tailwind_source_leaves_them_alone(self):
        self.assertNotIn("ws-section-icon", static_text("css", "tailwind.src.css"))


class WhichIcons(unittest.TestCase):
    def test_home_section_icons_carry_the_class(self):
        page = static_text("index.html")
        for icon_id in HOME_SECTION_ICON_IDS:
            m = re.search(r'<span id="' + icon_id + r'" class="([^"]*)"', page)
            self.assertIsNotNone(m, icon_id)
            self.assertIn("ws-section-icon", m.group(1).split(), icon_id)
        # The Continue skeleton's heading keeps the real row's shape: its icon too.
        self.assertRegex(page, r'<span class="ws-section-icon [^"]*invisible">auto_stories</span><h2 ')

    def test_continue_row_on_home_carries_the_class(self):
        books = static_text("js", "pages", "books.js")
        self.assertIn("head.appendChild(icon('auto_stories', 'ws-section-icon text-steel-blue'));", books)

    def test_nothing_else_carries_the_class(self):
        # Nav, tab bar, buttons, pills, empty states and service tiles keep
        # their icons: the class is on the six heading icons above and nowhere else.
        found = {}
        for root, _dirs, files in os.walk(STATIC):
            for f in files:
                if f.endswith((".html", ".js", ".mjs")):
                    path = os.path.join(root, f)
                    with open(path, encoding="utf-8") as fh:
                        n = fh.read().count("ws-section-icon")
                    if n:
                        found[os.path.relpath(path, STATIC)] = n
        self.assertEqual(found, {"index.html": 6, os.path.join("js", "pages", "books.js"): 1})


class SettingsPage(unittest.TestCase):
    def test_home_expander_has_the_switch(self):
        src = static_text("js", "settings", "pages.js")
        body = src[src.index("function homeExpander(api)"):src.index("function requestsExpander(api)")]
        self.assertIn("iconsCell.appendChild(api.toggle({ key: 'ui.section_icons', label: 'Icons beside section headings',",
                      body)


if __name__ == "__main__":
    unittest.main()
