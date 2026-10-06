"""
The self-hosted icon font (a trimmed Material Symbols Outlined).

Icons are ligatures: the text "home" in the icon font paints a house. The font
in app/static/fonts holds only the names in material-symbols-outlined.icons.txt,
so a name the code draws but the list leaves out would paint as letters. These
tests pin:

  * the list against the code: every Material Symbols name written in the
    app's pages, scripts and server code is in the list, unless it is one of
    the plain words below that the code uses for something else;
  * the list against the font: the font was rebuilt after the list last
    changed (scripts/build_icon_font.py records both in the manifest);
  * the settings that hold icons: their defaults and the picker's suggestions
    are in the list, and a stored name the font cannot draw is served as that
    slot's default (app/icons.py) instead of as letters;
  * the page head: every page declares the font from /static at a
    content-stamped address; no page loads it from Google any more.
"""
import hashlib
import json
import os
import pathlib
import re
import unittest

from app import pages
from app.icons import ICON_NAMES, drawable, icon_or

APP = pathlib.Path(__file__).resolve().parent.parent
STATIC = APP / "static"
FONTS = STATIC / "fonts"
LIST = FONTS / "material-symbols-outlined.icons.txt"
CATALOGUE = pathlib.Path(__file__).resolve().parent / "material_symbols_names.txt"

# Words the code uses that happen to be Material Symbols names but are never
# drawn as icons (attribute names, event names, keys, page ids...). A word
# here that the code later draws as an icon must move to the icon list.
# Check every place a word appears before adding it: helpers such as
# methodCard('password', ...) and the editors' toolbar tables pass icon
# names as plain strings.
NOT_ICONS = frozenset("""
album api approval badge block cached cancel class clear colors cookie deselect details dock docs domain done
downloading feed files filter fullscreen function height host http https iframe input ios light list login
menu message monitor mouse move news note notes overview pages pattern pending people percent pin place polyline post
preview priority queue radio resize resume script sd select sleep sort source stars start stop stream style
switch tab table target timer today toolbar transform upgrade verified web webhook width window work
""".split())

# A lowercase word between quotes or backticks, or alone between > and <.
_LITERAL = re.compile(r"""(['"`])([a-z][a-z0-9_]*)\1|>\s*([a-z][a-z0-9_]*)\s*<""")


def _lines(path):
    return [s for s in (line.strip() for line in path.read_text(encoding="utf-8").splitlines())
            if s and not s.startswith("#")]


def _catalogue():
    return frozenset(_lines(CATALOGUE))


def _code_files():
    for p in sorted(APP.rglob("*")):
        if p.suffix not in (".py", ".js", ".mjs", ".html") or not p.is_file():
            continue
        rel = p.relative_to(APP).parts
        if rel[0] == "tests" or rel[:2] == ("static", "css"):
            continue
        yield p


def names_in_code():
    """{Material Symbols name written in the app's code: [files]}."""
    catalogue = _catalogue()
    found = {}
    for p in _code_files():
        for m in _LITERAL.finditer(p.read_text(encoding="utf-8", errors="replace")):
            name = m.group(2) or m.group(3)
            if name in catalogue:
                found.setdefault(name, set()).add(str(p.relative_to(APP)))
    return found


class TheList(unittest.TestCase):
    def test_every_listed_name_is_a_material_symbol(self):
        unknown = sorted(set(_lines(LIST)) - _catalogue())
        self.assertEqual(unknown, [], "not Material Symbols names (a typo?)")

    def test_the_app_reads_the_same_list(self):
        self.assertEqual(ICON_NAMES, frozenset(_lines(LIST)))
        self.assertGreater(len(ICON_NAMES), 100)

    def test_every_icon_the_code_names_is_in_the_list(self):
        missing = {n: sorted(files) for n, files in names_in_code().items()
                   if n not in ICON_NAMES and n not in NOT_ICONS}
        self.assertEqual(missing, {}, "Add these to app/static/fonts/material-symbols-outlined.icons.txt and "
                                      "run scripts/build_icon_font.py (or, for a word that is never drawn as an "
                                      "icon, to NOT_ICONS in this test)")

    def test_no_word_is_both_an_icon_and_not_one(self):
        self.assertEqual(sorted(ICON_NAMES & NOT_ICONS), [])

    def test_the_scan_finds_the_ways_the_code_draws_icons(self):
        # One of each: page markup, a JS helper call, a JS table, Python markup.
        found = names_in_code()
        for name, where in (("chevron_left", "static/book.html"), ("content_copy", "static/js/settings/integrations.js"),
                            ("format_bold", "static/js/news-editor.js"), ("push_pin", "home_news.py")):
            self.assertIn(where, found.get(name, ()), name)


class TheFont(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((FONTS / "material-symbols-outlined.json").read_text(encoding="utf-8"))

    def test_the_font_was_built_from_this_list(self):
        names = sorted(set(_lines(LIST)))
        digest = hashlib.sha256("\n".join(names).encode("utf-8")).hexdigest()
        self.assertEqual(self.manifest["names_sha256"], digest,
                         "the icon list changed since the font was built: run scripts/build_icon_font.py")
        self.assertEqual(self.manifest["icons"], len(names))

    def test_the_font_is_the_one_the_build_wrote(self):
        data = (FONTS / "material-symbols-outlined.woff2").read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), self.manifest["woff2_sha256"])
        self.assertEqual(data[:4], b"wOF2")
        self.assertLess(len(data), 80_000)

    def test_it_keeps_the_weights_and_fill_the_site_draws(self):
        self.assertEqual(self.manifest["axes"], {"FILL": [0.0, 1.0], "wght": [400.0, 700.0]})

    def test_the_licence_sits_next_to_it(self):
        text = (FONTS / "LICENSE-material-symbols.txt").read_text(encoding="utf-8")
        self.assertIn("Apache License", text)
        self.assertIn("Version 2.0", text)


class IconSettings(unittest.TestCase):
    def test_icon_setting_defaults_are_drawable(self):
        from app.settings_registry import REGISTRY
        icon_defs = [d for d in REGISTRY.values() if d.type == "icon"]
        self.assertGreater(len(icon_defs), 10)
        self.assertEqual([d.key for d in icon_defs if not drawable(d.default)], [])

    def test_the_pickers_suggestions_are_drawable(self):
        kit = (STATIC / "js" / "settings" / "kit.js").read_text(encoding="utf-8")
        body = re.search(r"var ICONS = \[(.*?)\];", kit, re.S).group(1)
        suggested = re.findall(r"'([a-z0-9_]+)'", body)
        self.assertGreater(len(suggested), 50)
        self.assertEqual([n for n in suggested if not drawable(n)], [])

    def test_icon_or(self):
        self.assertEqual(icon_or("home", "x"), "home")
        self.assertEqual(icon_or("rocket", "home"), "home")
        self.assertEqual(icon_or(None, "home"), "home")
        self.assertFalse(drawable(""))

    def test_branding_serves_the_default_for_an_icon_the_font_cannot_draw(self):
        from app.routers.branding import DEFAULTS, build_branding
        b = build_branding({"icon.nav_home": "rocket", "icon.nav_wiki": "folder",
                            "icon.section_news": "not_a_real_icon", "icon.sidebar_logo": "rocket"},
                           {}, None, {"tickets": None, "issues": None, "playback": None})
        self.assertEqual(b["icons"]["nav_home"], DEFAULTS["icon.nav_home"])
        self.assertEqual(b["icons"]["nav_wiki"], "folder")
        self.assertEqual(b["icons"]["section_news"], DEFAULTS["icon.section_news"])
        self.assertEqual(b["icons"]["sidebar_logo"], DEFAULTS["icon.sidebar_logo"])

    def test_a_monitor_icon_the_font_cannot_draw_reads_as_unset(self):
        from app.routers.integrations import _get_monitor_preferences
        from app.tests import helpers
        db = helpers.make_sessionmaker()()
        try:
            helpers.put(db, "monitor.7.icon", "dns")
            helpers.put(db, "monitor.8.icon", "rocket")
            self.assertEqual(_get_monitor_preferences(db, 7)["icon"], "dns")
            self.assertEqual(_get_monitor_preferences(db, 8)["icon"], "")
        finally:
            db.close()


class PageHead(unittest.TestCase):
    def setUp(self):
        pages.STATIC_DIR = str(STATIC)

    def test_no_page_loads_the_icon_font_from_google(self):
        for p in sorted(STATIC.glob("*.html")) + sorted((STATIC / "partials").glob("*.html")):
            self.assertNotIn("Material+Symbols", p.read_text(encoding="utf-8"), p.name)

    def test_every_rendered_page_declares_the_self_hosted_font(self):
        from app.tests.test_pages import render
        for name in ("index", "login", "settings", "setup"):
            page = (STATIC / f"{name}.html").read_text(encoding="utf-8")
            out = render(name=name, page=page)
            head = out.split("</head>", 1)[0]
            face = re.findall(r"@font-face\{font-family:'Material Symbols Outlined';[^}]*src:url\(([^)]+)\)", head)
            self.assertEqual(len(face), 1, name)
            # Content-stamped, so it can be cached for a year (main.py).
            self.assertRegex(face[0], r"^/static/fonts/material-symbols-outlined\.woff2\?v=[\w.-]+-[0-9a-f]{8}$")
            self.assertIn("font-weight:400 700;font-display:block;", head)
            # Not preloaded: on a slow phone that delayed the page's largest
            # text (pages.icon_font_head).
            self.assertNotIn('as="font"', head, name)
            # Before app.css, as Google's stylesheet was, so utilities on an
            # icon (font-bold) still win over the family's own rules.
            self.assertLess(head.index(".material-symbols-outlined{"), head.index("/static/css/app.css"), name)

    def test_the_font_is_a_static_file_the_csp_allows(self):
        from fastapi.testclient import TestClient
        from app.main import app
        r = TestClient(app).get("/static/fonts/material-symbols-outlined.woff2")
        self.assertEqual(r.status_code, 200)
        self.assertIn("font-src 'self'", r.headers["content-security-policy"])


if __name__ == "__main__":
    unittest.main()
