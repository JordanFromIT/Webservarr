"""
The frosted glass's blur is a theme setting (theme.frost_blur, whole px from
0 to 32, shipped as 15: the glass slab's own blur).

It reaches the page through the theme engine's one chain: the registry, the
branding payload, the page's #ws-theme (--ws-frost-blur, so the first paint
is right), theme-loader.js (inline on <html>, and again after a Settings
save) and theme.css's zero-specificity default. Every frosted surface paints
the one token (test_frost.py), the sign-in card included, so they all change
together. Settings > Appearance offers it as a slider with a sample pane.

Run inside the container:
    python -m unittest discover -s /app/app/tests -t /app -v
"""
import re
import unittest

from app.tests.test_motion import css_rule
from app.tests.test_shell_contract import STATIC, live_matches
from app.tests.test_theme_engine import (
    APPEARANCE, FRAME, HAVE_APP, KIT, LOADER, THEME, blocks, declared, payload,
)

KEY = "theme.frost_blur"
LOGIN = (STATIC / "login.html").read_text(encoding="utf-8")

if HAVE_APP:
    from app import pages, seed, settings_registry
    from app.models import Setting
    from app.routers.branding import DEFAULTS as BRANDING_DEFAULTS
    from app.settings_registry import REGISTRY
    from app.tests.test_push import make_session_factory


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class TheSetting(unittest.TestCase):
    def ws_theme(self, values=None) -> dict:
        style = pages.theme_style(payload(values))
        return declared(re.search(r'<style id="ws-theme">:root\{(.*)\}</style>', style).group(1))

    def test_registry_row(self):
        d = REGISTRY[KEY]
        self.assertEqual((d.type, d.default, d.min, d.max, d.public, d.allow_empty),
                         ("int", "15", 0, 32, True, False))
        for ok in ("0", "4", "16", "32"):
            self.assertIsNone(settings_registry.validate_value(KEY, ok), ok)
        for bad in ("-1", "33", "4.5", "4px", "", "lots"):
            self.assertIsNotNone(settings_registry.validate_value(KEY, bad), bad)

    def test_seeded_and_served_as_the_default(self):
        self.assertEqual(seed.DEFAULT_SETTINGS[KEY][0], "15")
        self.assertEqual(BRANDING_DEFAULTS[KEY], "15")

    def test_an_existing_install_gets_it_and_keeps_its_own_value(self):
        Session = make_session_factory()
        db = Session()
        try:
            for key, (value, desc) in seed.DEFAULT_SETTINGS.items():
                if key != KEY:
                    db.add(Setting(key=key, value=value, description=desc))
            db.commit()
            seed.seed_default_settings(db)
            self.assertEqual(db.query(Setting).filter(Setting.key == KEY).one().value, "15")
            db.query(Setting).filter(Setting.key == KEY).one().value = "12"
            db.commit()
            seed.seed_default_settings(db)
            self.assertEqual(db.query(Setting).filter(Setting.key == KEY).one().value, "12")
        finally:
            db.close()

    def test_the_payload_is_a_whole_number_inside_the_bounds(self):
        self.assertEqual(payload()["frost_blur"], 15)
        self.assertEqual(payload({KEY: "16"})["frost_blur"], 16)
        self.assertEqual(payload({KEY: "0"})["frost_blur"], 0)
        self.assertEqual(payload({KEY: "99"})["frost_blur"], 32)      # a hand-edited row is held in bounds
        self.assertEqual(payload({KEY: "-5"})["frost_blur"], 0)
        for junk in ("", "4px", "blur(9px)", "x;}"):
            self.assertEqual(payload({KEY: junk})["frost_blur"], 15, junk)

    def test_ws_theme_writes_the_token(self):
        self.assertEqual(self.ws_theme()["--ws-frost-blur"], "blur(15px)")
        self.assertEqual(self.ws_theme({KEY: "16"})["--ws-frost-blur"], "blur(16px)")
        self.assertEqual(self.ws_theme({KEY: "0"})["--ws-frost-blur"], "blur(0px)")

    def test_ws_theme_is_safe_for_any_dict_it_is_handed(self):
        for odd, want in ((None, 15), ("16", 15), (True, 15), (7.5, 15), (-3, 0), (500, 32), (9, 9)):
            style = pages.theme_style(dict(payload(), frost_blur=odd))
            self.assertIn(f"--ws-frost-blur:blur({want}px)", style, odd)

    def test_safe_colours_keep_the_blur(self):
        # /settings?theme=safe is about colours: the glass stays the operator's.
        safe = pages.safe_theme_branding(payload({KEY: "12"}))
        self.assertIn("--ws-frost-blur:blur(12px)", pages.theme_style(safe))

    def test_the_shell_fragment_carries_it_after_a_save(self):
        frag = pages.shell_fragment(payload({KEY: "20"}), True, "settings", "WebServarr - Settings")
        self.assertIn("--ws-frost-blur:blur(20px)", frag["theme_css"])
        self.assertEqual(frag["branding"]["frost_blur"], 20)
        # theme.* keys refresh the shell (kit.js SHELL_KEYS).
        self.assertRegex(KEY, re.search(r"var SHELL_KEYS = /([^\n]*)/;", KIT).group(1))


class TheChain(unittest.TestCase):
    def test_the_stylesheet_default_has_no_specificity(self):
        root = declared(blocks(THEME, ":where(:root)")[0])
        self.assertEqual(root["--ws-frost-blur"], "blur(15px)")
        for body in blocks(THEME, ":root"):
            self.assertNotIn("--ws-frost-blur", declared(body))

    def test_the_loader_sets_it_from_the_payload(self):
        self.assertTrue(live_matches(LOADER, r"var blur = data\.frost_blur;"))
        self.assertTrue(live_matches(
            LOADER, r"if \(typeof blur === 'number' && blur % 1 === 0 && blur >= 0 && blur <= 32\) \{"))
        self.assertTrue(live_matches(LOADER, r"root\.style\.setProperty\('--ws-frost-blur', 'blur\(' \+ blur \+ 'px\)'\);"))

    def test_every_blur_on_a_frosted_surface_is_the_token(self):
        # The class, the player's notices and drop-down, the stuck sheet head
        # and the sign-in card: no frosted surface keeps a blur of its own.
        rule = re.search(r"\n\.ws-frost \{([^}]*)\}", THEME).group(1)
        self.assertIn("backdrop-filter: var(--ws-frost-blur) var(--ws-frost-boost);", rule)
        card = re.search(r"\.login-glass-card \{([^}]*)\}", LOGIN).group(1)
        self.assertIn("backdrop-filter: var(--ws-frost-blur) var(--ws-frost-boost);", card)
        self.assertNotIn("blur(15px)", LOGIN)
        self.assertEqual(THEME.count("blur(15px)"), 1, "only the default")
        # Every surface on the slab adds the boost after the setting's blur.
        for sel in (".wsp-notice", ".wsp-full.is-window"):
            self.assertIn("backdrop-filter: var(--ws-frost-blur) var(--ws-frost-boost);", css_rule(THEME, sel), sel)


class AppearanceOffersIt(unittest.TestCase):
    def test_the_slider(self):
        self.assertIn("var BLUR = 'theme.frost_blur';", APPEARANCE)
        self.assertTrue(live_matches(APPEARANCE, r"WSSettings\.card\('Frosted glass',"))
        self.assertTrue(live_matches(APPEARANCE, r"range\.type = 'range';"))
        self.assertTrue(live_matches(APPEARANCE, r"var range = el\('input', 'wsp-range'\);"))
        self.assertTrue(live_matches(APPEARANCE, r"range\.step = '1';"))
        # Bounds from the registry (the settings meta), with the registry's own as fallback.
        self.assertTrue(live_matches(APPEARANCE, r"range\.min = String\(m\.min != null \? m\.min : 0\);"))
        self.assertTrue(live_matches(APPEARANCE, r"range\.max = String\(m\.max != null \? m\.max : 32\);"))
        # It stages through the kit, so Save, Discard and Reset treat it like every field.
        self.assertTrue(live_matches(APPEARANCE, r"api\.set\(BLUR, range\.value\);"))
        self.assertTrue(live_matches(APPEARANCE, r"api\.track\(BLUR, \{"))
        # Named by its label and read out in words.
        self.assertTrue(live_matches(APPEARANCE, r"label\.htmlFor = range\.id;"))
        self.assertTrue(live_matches(APPEARANCE, r"range\.setAttribute\('aria-valuetext', "))

    def test_moving_it_restyles_every_frosted_surface(self):
        # Like a colour: the token on <html>, which every frosted surface reads;
        # the kit repaints from the saved value on Discard or leaving.
        self.assertTrue(live_matches(
            APPEARANCE, r"root\.style\.setProperty\('--ws-frost-blur', 'blur\(' \+ px \+ 'px\)'\);"))

    def test_the_sample_is_the_real_frost(self):
        self.assertTrue(live_matches(APPEARANCE, r"var pane = el\('div', 'ws-frost [^']*'"))
        self.assertTrue(live_matches(APPEARANCE, r"stage\.setAttribute\('aria-label', 'Blur preview'\);"))

    def test_reset_stages_it(self):
        keys = re.search(r"var KEYS = (.*?);\n", APPEARANCE, re.S).group(1)
        self.assertIn("BLUR", keys)

    def test_the_skeleton_has_the_card_after_font(self):
        panel = FRAME[FRAME.index('<section id="panel-appearance"'):]
        panel = panel[:panel.index("</section>")]
        font = panel.index('<span class="skel-text">Font</span></h2>')
        glass = panel.index('<span class="skel-text">Frosted glass</span>')
        css = panel.index("Custom CSS (advanced)")
        self.assertLess(font, glass)
        self.assertLess(glass, css)
        card = panel[glass:css]
        self.assertIn('<span class="skel-text">Blur</span>', card)
        self.assertIn('<div class="h-6 flex items-center"><div class="skel h-1 w-full rounded-full"></div></div>', card)
        self.assertIn('<div class="skel h-44 rounded-2xl border border-transparent max-w-2xl"></div>', card)
        # The words are the tab's own.
        for words in ("Menus, pop-ups, dialogs and the sign-in card are frosted glass. "
                      "Choose how much they blur what is behind them.",
                      "0 px is clear glass. The default is 15 px."):
            self.assertIn(words, card)
            self.assertIn(words.split(". ")[0], APPEARANCE)


if __name__ == "__main__":
    unittest.main()
