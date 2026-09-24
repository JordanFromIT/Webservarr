"""
Static contract for the Settings frame, the shared UI helpers and the tab
modules: every tab has a link, a panel and a module; nothing uses a colour
outside the theme engine, a native dialog, or text under 12px.
"""
import re
import unittest
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "static"
FRAME = "settings-next.html"     # renamed to settings.html in Task 8.1
TABS = ["general", "pages", "appearance", "sign-in", "integrations", "notifications"]
MODULES = {"general": "general.js", "pages": "pages.js", "appearance": "appearance.js",
           "sign-in": "signin.js", "integrations": "integrations.js", "notifications": "notifications.js"}
# Text colour from outside the theme engine: a Tailwind palette class, an
# arbitrary text-[#hex] / text-[rgb(...)] / text-[hsl(...)], or an inline
# color: #... / rgb(...) / hsl(...) in markup or a JS string. rgb(var(--...))
# is the theme engine itself and stays allowed; background-color and
# border-color are not text.
PALETTE_TEXT = re.compile(
    r"\btext-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|"
    r"teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b"
    r"|\btext-\[(?:#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()"
    r"|(?<![\w-])color\s*:\s*(?:#[0-9a-fA-F]{3,8}\b|rgba?\((?!\s*var\()|hsla?\()"
    r"|\.style\.color\s*=\s*['\"](?:#|rgba?\((?!\s*var\()|hsla?\()")
NATIVE_DIALOG = re.compile(r"(?<![\w.])(?<!function )(?:confirm|alert|prompt)\(|window\.(?:confirm|alert|prompt)\(")
# Text under the 12px / 0.75rem floor, as an arbitrary Tailwind size or an
# inline font-size (markup or JS). A fraction of a rem/em is under the floor
# when it is below .75: .0-.6x, or .7 followed by nothing or 0-4.
_UNDER_075 = r"(?<![\d.])0?\.(?:[0-6]\d*|7(?:[0-4]\d*)?)(?:r?em)\b"
TINY_TEXT = re.compile(
    r"text-\[(?:(?:\d|1[01])(?:\.\d+)?px|" + _UNDER_075 + r")\]"
    r"|(?:font-size\s*:|fontSize\s*=)\s*['\"]?\s*(?:(?:\d|1[01])(?:\.\d+)?px\b|" + _UNDER_075 + r")")

try:
    from fastapi.testclient import TestClient  # noqa: F401
    from app.tests.test_page_gating import ADMIN_SESSION, MEMBER_SESSION, PageRoutesBase
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False
    PageRoutesBase = unittest.TestCase


# The shared shell scripts every page loads; the shell contract guards them.
# Everything else the frame loads is a Settings file and is scanned below.
SHELL_JS = {"js/theme-loader.js", "js/auth.js", "js/shell.js", "js/notifications.js"}

# Files the frame references that later tasks write. Each task deletes its own
# entries when it adds the file (a file here that exists fails the test), and
# Task 8.4 asserts the set is empty. Task 3.2 added ui.js, kit.js and the first
# General fields (general.js, which Task 4.3 completes).
PENDING = {
    "js/settings/appearance.js",         # Task 4.4
    "js/settings/signin.js",             # Task 4.5
    "js/settings/pages.js",              # Task 5.1
    "js/settings/integrations.js",       # Task 6.3
    "js/settings/notifications.js",      # Task 6.5
}


def referenced_js():
    """Every /static/js/... file the frame loads, the template modules included,
    less the shared shell scripts."""
    h = (STATIC / FRAME).read_text(encoding="utf-8")
    return sorted(set(re.findall(r'\bsrc="/static/(js/[^"?]+\.js)[?"]', h)) - SHELL_JS)


def settings_files():
    """The frame, every Settings script it references that exists, and every
    js/settings/*.js file. A referenced file may only be missing while it is
    in PENDING (checked by Hygiene.test_referenced_files_exist_or_are_pending)."""
    files = {STATIC / FRAME}
    files.update(STATIC / rel for rel in referenced_js() if (STATIC / rel).exists())
    files.update((STATIC / "js" / "settings").glob("*.js"))
    return sorted(files)


class Frame(unittest.TestCase):
    def test_every_tab_has_a_link_a_panel_and_a_module(self):
        h = (STATIC / FRAME).read_text(encoding="utf-8")
        for t in TABS:
            self.assertRegex(h, rf'<a[^>]*href="#{t}"[^>]*data-tab="{t}"', t)
            self.assertIn(f'data-settings-panel="{t}"', h)
            self.assertIn(f'<script data-tab="{t}" src="/static/js/settings/{MODULES[t]}?v=1"></script>', h)
        self.assertIn('id="settingsSaveBar"', h)
        self.assertIn('id="settingsModules"', h)
        self.assertLess(h.index("/static/js/ui.js?v="), h.index("/static/js/settings/kit.js?v="))
        self.assertLess(h.index("/static/js/auth.js?v="), h.index("/static/js/settings/kit.js?v="))

    def test_first_paint_selects_the_tab_from_the_hash(self):
        h = (STATIC / FRAME).read_text(encoding="utf-8")
        self.assertIn("data-settings-tab", h)
        # Set in <head>, so nothing in the body - the tab strip included -
        # paints before the tab is known.
        head = h[:h.index("</head>")]
        self.assertRegex(head, r"document\.documentElement\.setAttribute\(\s*'data-settings-tab'")
        css = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        for t in TABS:
            self.assertIn(f'html[data-settings-tab="{t}"] [data-settings-panel="{t}"]', css)
            # The selected tab's look comes from the same attribute.
            self.assertIn(f'html[data-settings-tab="{t}"] #tab-{t}', css)
        for token in ("--ws-status-ok", "--ws-status-warn", "--ws-status-err", ".ws-light-ok",
                      ".ws-light-warn", ".ws-light-error", ".ws-light-unconfigured", ".ws-invalid",
                      ".ws-switch", ".ws-tab", ".ws-savebar", ".ws-admin-only"):
            self.assertIn(token, css)

    def test_tab_scroll_hints_fade_the_strip_edge(self):
        # On a phone the arrows sit over the strip; each carries an edge fade
        # from the page background so it never lies on top of tab text.
        h = (STATIC / FRAME).read_text(encoding="utf-8")
        for side in ("Left", "Right"):
            m = re.search(rf'<div id="settingsTabHint{side}" class="([^"]*)"', h)
            self.assertIsNotNone(m, side)
            self.assertIn(f"ws-tab-hint-{side.lower()}", m.group(1).split(), side)
        css = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        for side in ("left", "right"):
            rule = re.search(rf"\.ws-tab-hint-{side}\s*\{{([^}}]*)\}}", css)
            self.assertIsNotNone(rule, side)
            self.assertIn("linear-gradient(", rule.group(1), side)
            self.assertIn("rgb(var(--color-background)", rule.group(1), side)

    def test_reduced_motion_stills_the_tab_hints(self):
        # The hints fade with transition-opacity; reduced motion switches that off.
        css = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        blocks = re.findall(r"@media \(prefers-reduced-motion: reduce\) \{(.*?)\n\}", css, re.S)
        still = [b for b in blocks if ".ws-savebar" in b]
        self.assertTrue(still, "the Settings reduced-motion block is missing")
        for side in ("left", "right"):
            self.assertRegex(still[0], rf"\.ws-tab-hint-{side}\b[^{{}}]*\{{[^}}]*transition:\s*none", side)


class Hygiene(unittest.TestCase):
    def test_referenced_files_exist_or_are_pending(self):
        refs = referenced_js()
        self.assertIn("js/ui.js", refs)
        self.assertIn("js/settings/kit.js", refs)
        for rel in refs:
            exists = (STATIC / rel).exists()
            if rel in PENDING:
                self.assertFalse(exists, f"{rel} exists now: remove it from PENDING")
            else:
                self.assertTrue(exists, f"{rel} is loaded by the frame but missing")
        self.assertEqual(sorted(PENDING - set(refs)), [], "PENDING lists files the frame does not load")

    def test_theme_colours_only_no_native_dialogs_no_tiny_text(self):
        for f in settings_files():
            text = f.read_text(encoding="utf-8")
            self.assertIsNone(PALETTE_TEXT.search(text), f"{f.name}: palette colour on text")
            self.assertIsNone(NATIVE_DIALOG.search(text), f"{f.name}: native dialog")
            self.assertIsNone(TINY_TEXT.search(text), f"{f.name}: text under 12px")

    def test_no_default_tables_in_the_front_end(self):
        for f in settings_files():
            text = f.read_text(encoding="utf-8")
            # Font names are legitimate choices in the Appearance font list, so the
            # default font is not checked here; colours, tagline and icon defaults are.
            for leaked in ("#125793", "#2C6DA1", "#4684B0", "#BEEEF4", "#E9D5FF", "#67E8F9", "#FCD34D",
                           "Media Server Management", "health_metrics", "confirmation_number",
                           "settings_input_component", "***masked***"):
                self.assertNotIn(leaked, text, f"{f.name} carries a default ({leaked}); read it from meta")


class KitApi(unittest.TestCase):
    def test_ui_js_public_api(self):
        js = (STATIC / "js" / "ui.js").read_text(encoding="utf-8")
        for name in ("el", "icon", "toast", "confirm", "cls"):
            self.assertRegex(js, rf"\b{name}: {name}\b", name)

    def test_kit_public_api(self):
        js = (STATIC / "js" / "settings" / "kit.js").read_text(encoding="utf-8")
        for name in ("boot", "registerTab", "go", "metaFor", "card"):
            self.assertRegex(js, rf"\b{name}: {name}\b", name)
        for method in ("text", "textarea", "toggle", "select", "color", "iconPicker", "secret", "track",
                       "get", "set", "stageDefaults", "onChange", "onSaved", "onDiscard", "beforeSave",
                       "fieldError", "dirtyKeys", "save"):
            self.assertIn(f"api.{method} = function", js, method)
        for event in ("ws-settings:saved", "ws-settings:discarded", "ws-settings:tab"):
            self.assertIn(event, js)
        self.assertIn("beforeunload", js)
        self.assertIn("/api/admin/settings?view=registry", js)
        self.assertIn("/api/admin/settings/bulk", js)

    def test_mask_comes_from_the_server(self):
        # One copy of the sentinel: the SettingsView payload. The kit re-exports
        # it as WSSettings.MASK; the leak test keeps any literal copy out.
        js = (STATIC / "js" / "settings" / "kit.js").read_text(encoding="utf-8")
        self.assertIn("data.mask", js)
        self.assertRegex(js, r"defineProperty\(WSSettings, 'MASK'")

    def test_tab_state_follows_every_switch(self):
        # The selected look is CSS on html[data-settings-tab]; the kit keeps it,
        # aria-selected and the URL in step for clicks, keys, hash and history.
        js = (STATIC / "js" / "settings" / "kit.js").read_text(encoding="utf-8")
        self.assertRegex(js, r"documentElement\.setAttribute\('data-settings-tab'")
        self.assertIn("aria-selected", js)
        self.assertIn("'hashchange'", js)
        self.assertIn("'popstate'", js)
        for hint in ("settingsTabHintLeft", "settingsTabHintRight"):
            self.assertIn(hint, js)

    def test_modules_register_their_tab(self):
        for tab, module in MODULES.items():
            path = STATIC / "js" / "settings" / module
            if path.exists():
                self.assertIn(f"WSSettings.registerTab('{tab}'", path.read_text(encoding="utf-8"), module)


class Guards(unittest.TestCase):
    """The hygiene patterns catch what they are for and let the theme through."""

    def test_off_theme_text_colour(self):
        for bad in ('class="text-green-500"', 'class="text-white"', 'class="text-[#ff0000]"',
                    'class="text-[rgb(1,2,3)]"', 'class="text-[hsl(0 0% 50%)]"',
                    'style="font-weight:600;color: #abc"', 'style="color:rgb(0, 0, 0)"',
                    "'<span style=\"color: hsl(0,0%,50%)\">'", "el.style.color = '#fff';",
                    "el.style.color = \"rgb(1,2,3)\";"):
            self.assertIsNotNone(PALETTE_TEXT.search(bad), bad)
        for ok in ('class="text-frosted-blue/70"', 'class="text-primary"', "color: rgb(var(--color-text) / .7);",
                   "color: rgb( var(--color-text));", "background-color: #000;", "border-color: rgb(1,2,3);",
                   "el.style.color = 'rgb(var(--color-primary))';", 'class="text-[15px]"'):
            self.assertIsNone(PALETTE_TEXT.search(ok), ok)

    def test_text_under_twelve_pixels(self):
        for bad in ("text-[11px]", "text-[10.5px]", "text-[9px]", "text-[0.7rem]", "text-[.6rem]",
                    "text-[0.74rem]", "text-[0.7em]", 'style="font-size: 10px"', "font-size:0.6rem",
                    "font-size: .7em", "el.style.fontSize = '11px'", "el.style.fontSize = '0.625rem'"):
            self.assertIsNotNone(TINY_TEXT.search(bad), bad)
        for ok in ("text-[12px]", "text-[15px]", "text-[0.75rem]", "text-[.75rem]", "text-[0.8rem]",
                   "text-[1.5rem]", "text-[10.5rem]", "font-size: 12px", "font-size: 15px", "font-size: 0.75rem",
                   "font-size: 1.25rem", "el.style.fontSize = '14px'", "text-xs"):
            self.assertIsNone(TINY_TEXT.search(ok), ok)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Route(PageRoutesBase):
    def test_admins_get_the_frame_members_go_home(self):
        r = self.get("/settings/next", ADMIN_SESSION)
        self.assertEqual(r.status_code, 200)
        self.assertIn('data-page="settings-next"', r.text)
        self.assertRegex(r.text, r'<a[^>]*href="/settings"[^>]*aria-current="page"')
        r = self.get("/settings/next", MEMBER_SESSION)
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/"))


if __name__ == "__main__":
    unittest.main()
