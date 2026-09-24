"""
Static contract for the Settings frame, the shared UI helpers and the tab
modules: every tab has a link, a panel and a module; nothing uses a colour
outside the theme engine, a native dialog, or text under 12px.
"""
import re
import unittest
from pathlib import Path
from unittest import mock

STATIC = Path(__file__).resolve().parents[1] / "static"
FRAME = "settings-next.html"     # renamed to settings.html in Task 8.1
TABS = ["general", "pages", "appearance", "sign-in", "integrations", "notifications"]
MODULES = {"general": "general.js", "pages": "pages.js", "appearance": "appearance.js",
           "sign-in": "signin.js", "integrations": "integrations.js", "notifications": "notifications.js"}
PALETTE_TEXT = re.compile(
    r"\btext-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|"
    r"teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b")
NATIVE_DIALOG = re.compile(r"(?<![\w.])(?<!function )(?:confirm|alert|prompt)\(|window\.(?:confirm|alert|prompt)\(")
TINY_TEXT = re.compile(r"text-\[(?:\d|1[01])px\]")

try:
    from fastapi.testclient import TestClient  # noqa: F401
    from app.tests.test_page_gating import ADMIN_SESSION, MEMBER_SESSION, PageRoutesBase
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False
    PageRoutesBase = unittest.TestCase


def settings_files():
    files = [STATIC / FRAME, STATIC / "js" / "ui.js"] + sorted((STATIC / "js" / "settings").glob("*.js"))
    return [f for f in files if f.exists()]


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
        css = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        for t in TABS:
            self.assertIn(f'html[data-settings-tab="{t}"] [data-settings-panel="{t}"]', css)
        for token in ("--ws-status-ok", "--ws-status-warn", "--ws-status-err", ".ws-light-ok",
                      ".ws-light-warn", ".ws-light-error", ".ws-light-unconfigured", ".ws-invalid",
                      ".ws-switch", ".ws-tab", ".ws-savebar", ".ws-admin-only"):
            self.assertIn(token, css)


class Hygiene(unittest.TestCase):
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
            for leaked in ("#125793", "#2C6DA1", "#BEEEF4", "Media Server Management",
                           "health_metrics", "confirmation_number"):
                self.assertNotIn(leaked, text, f"{f.name} carries a default ({leaked}); read it from meta")


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
