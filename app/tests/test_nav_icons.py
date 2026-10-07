"""
Sidebar page icons (ui.nav_icons): the icon beside each page's name in the
desktop sidebar is a setting that ships on.

The server marks <html data-nav-icons-off> only while it is off, and one rule
in theme.css hides every .ws-nav-icon under that mark, so the first paint is
already right and a soft navigation (which copies <html>'s data- attributes)
keeps it in step. A save in Settings brings the page on screen in step through
the shell fragment. The phone's tab bar and More sheet keep their icons. These
tests pin the default, the registry, seeding and the branding payload in step,
the renderer's mark, the one CSS rule, which icons carry the class, the
Settings switch, and the soft navigation and save paths.
"""
import os
import re
import unittest

from app import pages
from app import settings_registry as reg
from app.tests import helpers
from app.tests.test_pages import branding, css_rules, data_of, html_tag, render, static_text

KEY = "ui.nav_icons"
MARK = "data-nav-icons-off"
STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")
OFF = {KEY: "false"}


def setUpModule():
    pages.STATIC_DIR = STATIC


class Setting(unittest.TestCase):
    def test_registry_ships_it_on(self):
        d = reg.REGISTRY[KEY]
        self.assertEqual((d.type, d.default, d.public, d.seed, d.secret), ("bool", "true", True, True, False))
        self.assertIsNone(reg.validate_value(KEY, "true"))
        self.assertIsNone(reg.validate_value(KEY, "false"))
        self.assertEqual(reg.validate_value(KEY, "yes"), "Must be on or off")

    def test_seed_and_branding_defaults_are_the_registrys(self):
        from app import seed
        from app.routers import branding as branding_router
        self.assertEqual(seed.DEFAULT_SETTINGS[KEY][0], "true")
        self.assertEqual(branding_router.DEFAULTS[KEY], "true")

    def test_seeding_inserts_it_on_and_never_overwrites(self):
        from app.seed import seed_default_settings
        db = helpers.make_sessionmaker()()
        try:
            seed_default_settings(db)
            self.assertEqual(helpers.get(db, KEY), "true")
            helpers.put(db, KEY, "false")
            seed_default_settings(db)
            self.assertEqual(helpers.get(db, KEY), "false")
        finally:
            db.close()

    def test_payload_is_on_unless_exactly_false(self):
        self.assertIs(branding()["nav_icons"], True)
        self.assertIs(branding(**OFF)["nav_icons"], False)
        for odd in ("true", "False", " false", "0", ""):
            self.assertIs(branding(**{KEY: odd})["nav_icons"], True, odd)


class Rendering(unittest.TestCase):
    PAGES = ("index", "calendar", "requests", "books", "settings", "login")

    def test_no_mark_by_default(self):
        for name in self.PAGES:
            self.assertNotIn(MARK, html_tag(render(name=name)), name)

    def test_mark_on_every_page_while_off(self):
        b = branding(**OFF)
        for name in self.PAGES:
            self.assertIn(" " + MARK, html_tag(render(name=name, b=b)), name)

    def test_payload_carries_it_for_the_client(self):
        self.assertIs(data_of(render())["branding"]["nav_icons"], True)
        self.assertIs(data_of(render(b=branding(**OFF)))["branding"]["nav_icons"], False)

    def test_the_sidebar_markup_is_the_same_either_way(self):
        # Only the mark changes: the links keep their icons in the markup, so
        # the switch never changes what the nav is, only what is painted.
        on = pages.render_nav_links(branding(), True, "settings")
        off = pages.render_nav_links(branding(**OFF), True, "settings")
        self.assertEqual(on, off)


class Css(unittest.TestCase):
    def test_one_rule_hides_the_icons_under_the_mark(self):
        rules = css_rules(static_text("css", "theme.css"))
        self.assertEqual(rules.get("html[data-nav-icons-off] .ws-nav-icon"), {"display": "none"})
        # Nothing else in theme.css styles the icons or keys on the mark.
        selectors = [s for s in rules if "ws-nav-icon" in s or MARK in s]
        self.assertEqual(selectors, ["html[data-nav-icons-off] .ws-nav-icon"])

    def test_tailwind_source_leaves_them_alone(self):
        self.assertNotIn("ws-nav-icon", static_text("css", "tailwind.src.css"))


class WhichIcons(unittest.TestCase):
    def test_every_sidebar_link_icon_carries_the_class(self):
        for tpl in (pages._LINK, pages._LINK_ACTIVE):
            m = re.search(r'<a [^>]*>\s*<span class="([^"]*)" aria-hidden="true">\{icon\}</span>', tpl)
            self.assertIsNotNone(m, tpl)
            self.assertIn("ws-nav-icon", m.group(1).split())
        nav = pages.render_nav_links(branding(), True, "settings")
        links = re.findall(r"<a\b", nav)
        self.assertGreater(len(links), 3)
        self.assertEqual(nav.count('class="ws-nav-icon '), len(links))

    def test_tabs_and_more_sheet_keep_their_icons(self):
        b = branding(**OFF)
        tabs, more = pages.phone_nav_items(b, True)
        self.assertTrue(tabs and more)
        for html_out in (pages.render_tabs(tabs, more, "settings"), pages.render_more_links(more, "settings")):
            self.assertNotIn("ws-nav-icon", html_out)
            self.assertIn("material-symbols-outlined", html_out)

    def test_nothing_else_carries_the_class(self):
        # Buttons, pills, tiles, cards and the phone's bars keep their icons:
        # the class is in the sidebar's two link templates and nowhere else.
        found = {}
        for root, _dirs, files in os.walk(STATIC):
            for f in files:
                if f.endswith((".html", ".js", ".mjs")):
                    path = os.path.join(root, f)
                    with open(path, encoding="utf-8") as fh:
                        if "ws-nav-icon" in fh.read():
                            found[os.path.relpath(path, STATIC)] = True
        self.assertEqual(found, {})
        with open(pages.__file__, encoding="utf-8") as fh:
            self.assertEqual(fh.read().count('"ws-nav-icon '), 2)


class SettingsPage(unittest.TestCase):
    def test_pages_tab_has_the_switch_above_the_list(self):
        src = static_text("js", "settings", "pages.js")
        mount = src[src.index("WSSettings.registerTab('pages'"):]
        switch = mount.index("card.body.appendChild(api.toggle({ key: 'ui.nav_icons', label: 'Icons in the sidebar',")
        self.assertLess(mount.index("WSSettings.card('Pages'"), switch)
        self.assertLess(switch, mount.index("card.body.appendChild(head);"))
        self.assertLess(switch, mount.index("card.body.appendChild(list);"))
        # The help says the phone keeps its icons.
        self.assertIn("The phone’s tab bar always keeps its icons.", mount[switch:switch + 300])


class SoftNavAndSave(unittest.TestCase):
    def test_the_router_copies_every_html_data_flag(self):
        # A soft navigation brings the mark in step: syncHtmlFlags adds and
        # removes every data- attribute on <html> to match the fetched page.
        router = static_text("js", "router.js")
        body = router[router.index("function syncHtmlFlags(fresh)"):router.index("function syncData(doc)")]
        self.assertIn("if (a.name.indexOf('data-') === 0 && !fresh.hasAttribute(a.name)) root.removeAttribute(a.name);",
                      body)
        self.assertIn("if (a.name.indexOf('data-') === 0 && root.getAttribute(a.name) !== a.value) "
                      "root.setAttribute(a.name, a.value);", body)

    def test_the_shell_fragment_says_what_the_page_marks(self):
        for b in (branding(), branding(**OFF)):
            frag = pages.shell_fragment(b, True, "settings", "WebServarr - Settings")
            marked = MARK in html_tag(render(name="settings", b=b))
            self.assertIs(frag["nav_icons"], not marked)

    def test_a_save_patches_the_mark_on_the_page_on_screen(self):
        kit = static_text("js", "settings", "kit.js")
        m = re.search(r"var SHELL_KEYS = (/[^\n]*/);", kit)
        self.assertIsNotNone(m)
        self.assertRegex(KEY, m.group(1)[1:-1])
        self.assertIn("'nav_icons', 'branding'].forEach", kit)
        shell = static_text("js", "shell.js")
        apply = shell[shell.index("function applyShell(parts)"):shell.index("function clearPageCache()")]
        self.assertIn("if (typeof parts.nav_icons === 'boolean') {", apply)
        self.assertIn("if (parts.nav_icons) root.removeAttribute('data-nav-icons-off');", apply)
        self.assertIn("else if (!root.hasAttribute('data-nav-icons-off')) root.setAttribute('data-nav-icons-off', '');",
                      apply)


if __name__ == "__main__":
    unittest.main()
