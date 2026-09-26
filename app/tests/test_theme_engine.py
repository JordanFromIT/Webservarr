"""
The theme engine: every colour the operator picks reaches the page through
one chain (registry -> branding payload -> the page's #ws-theme and #ws-data
-> theme-loader.js -> theme.css), and the page paints it in the right order.

Run inside the container:
    python -m unittest discover -s /app/app/tests -t /app -v
"""
import re
import unittest

from app.tests.test_motion import css_rule, top_level
from app.tests.test_shell_contract import STATIC, js_code_only, live_matches

THEME = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
LOADER = (STATIC / "js" / "theme-loader.js").read_text(encoding="utf-8")
HEADER = (STATIC / "partials" / "shell-header.html").read_text(encoding="utf-8")
APPEARANCE = (STATIC / "js" / "settings" / "appearance.js").read_text(encoding="utf-8")
TAILWIND = (STATIC.parents[1] / "tailwind.config.js").read_text(encoding="utf-8")

# The status colours (R138): one setting per state drives the dot, the ring and
# the words. Defaults suit the shipped dark background.
STATUS = {"status_ok": "#4ADE80", "status_warn": "#FBBF24", "status_err": "#F87171"}

try:
    from app import pages, seed, settings_registry
    from app.models import Setting
    from app.routers.branding import DEFAULTS as BRANDING_DEFAULTS, build_branding
    from app.settings_registry import REGISTRY
    from app.tests.test_push import make_session_factory
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False


def blocks(css: str, selector: str) -> list:
    """The bodies of every top-level rule written for exactly this selector."""
    return re.findall(r"(?:^|\})\s*" + re.escape(selector) + r"\s*\{([^{}]*)\}", top_level(css))


def declared(block: str) -> dict:
    return {k.strip(): v.strip() for k, v in (d.split(":", 1) for d in block.split(";") if ":" in d)}


def payload(values=None):
    return build_branding(values or {}, {}, None, {"tickets": None, "issues": None, "playback": None})


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class InlineThemeWins(unittest.TestCase):
    """L1: the server puts the operator's colours in <head> as #ws-theme, a
    :root rule, before theme.css loads. theme.css's defaults must not beat it,
    or the first paint (and any page whose script is slow or blocked) shows
    the shipped palette instead of the operator's."""

    def theme_vars(self):
        style = pages.theme_style(payload())
        body = re.search(r'<style id="ws-theme">:root\{(.*)\}</style>', style).group(1)
        return set(declared(body))

    def test_the_inline_theme_is_a_root_rule(self):
        self.assertRegex(pages.theme_style(payload()), r'^<style id="ws-theme">:root\{')

    def test_the_stylesheet_defaults_have_no_specificity(self):
        wanted = self.theme_vars()
        self.assertIn("--color-primary", wanted)
        self.assertIn("--font-display", wanted)
        defaults = blocks(THEME, ":where(:root)")
        self.assertEqual(len(defaults), 1, "one :where(:root) block of defaults")
        self.assertEqual(sorted(wanted - set(declared(defaults[0]))), [], "a variable with no default")

    def test_no_plain_root_rule_redeclares_an_inline_variable(self):
        wanted = self.theme_vars()
        for body in blocks(THEME, ":root"):
            clash = sorted(wanted & set(declared(body)))
            self.assertEqual(clash, [], "a :root rule in theme.css outranks #ws-theme for these")


def rgb(hex_value: str) -> str:
    h = hex_value.lstrip("#")
    return f"{int(h[0:2], 16)} {int(h[2:4], 16)} {int(h[4:6], 16)}"


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class StatusColoursAreSettings(unittest.TestCase):
    """R138: status colours are theme options like the media colours: a
    registry row with a default, the branding payload, #ws-theme, the loader,
    theme.css's defaults, and a picker in Appearance."""

    def test_registry_rows(self):
        for key, default in STATUS.items():
            with self.subTest(key):
                d = REGISTRY["theme.color_" + key]
                self.assertEqual((d.type, d.default, d.public, d.allow_empty), ("color", default, True, False))
                self.assertEqual(settings_registry.validate_value(d.key, "#15803D"), None)
                self.assertIsNotNone(settings_registry.validate_value(d.key, "green"))

    def test_they_are_seeded_and_served_as_defaults(self):
        for key, default in STATUS.items():
            self.assertEqual(seed.DEFAULT_SETTINGS["theme.color_" + key][0], default)
            self.assertEqual(BRANDING_DEFAULTS["theme.color_" + key], default)

    def test_an_existing_install_gets_them_and_keeps_its_own_colours(self):
        # New keys with defaults, not a changed default: seeding inserts the
        # missing rows on the next start and touches nothing already stored.
        Session = make_session_factory()
        db = Session()
        try:
            for key, (value, desc) in seed.DEFAULT_SETTINGS.items():
                if not key.startswith("theme.color_status_"):
                    value = "#FF00FF" if key == "theme.color_primary" else value
                    db.add(Setting(key=key, value=value, description=desc))
            db.commit()
            seed.seed_default_settings(db)
            got = {r.key: r.value for r in db.query(Setting).all()}
        finally:
            db.close()
        for key, default in STATUS.items():
            self.assertEqual(got["theme.color_" + key], default)
        self.assertEqual(got["theme.color_primary"], "#FF00FF")

    def test_the_payload_carries_them_safely(self):
        colors = payload({"theme.color_status_ok": "#15803D", "theme.color_status_warn": "amber",
                          "theme.color_status_err": "#B91C1C;x"})["colors"]
        self.assertEqual(colors["status_ok"], "#15803D")
        self.assertEqual(colors["status_warn"], STATUS["status_warn"])
        self.assertEqual(colors["status_err"], STATUS["status_err"])

    def test_every_payload_colour_is_inlined(self):
        b = payload({"theme.color_status_err": "#B91C1C"})
        style = pages.theme_style(b)
        for key, value in b["colors"].items():
            var = key.replace("_", "-")
            self.assertIn(f"--color-{var}:{rgb(value)}", style, key)
            self.assertIn(f"--hex-{var}:{value}", style, key)
        self.assertIn("--color-status-err:185 28 28", style)

    def test_the_loader_applies_every_colour_it_is_sent(self):
        # One loop over the payload's colours, so a colour the server adds is
        # never left to the defaults on the fallback path.
        code = js_code_only(LOADER)
        self.assertTrue(live_matches(LOADER, r"setProperty\('--color-' \+"), "no --color-* loop")
        self.assertTrue(live_matches(LOADER, r"setProperty\('--hex-' \+"), "no --hex-* loop")
        self.assertNotRegex(code, r"c\.media_movie")

    def test_stylesheet_defaults_are_the_registry_defaults(self):
        root = declared(blocks(THEME, ":where(:root)")[0])
        for key, default in STATUS.items():
            var = key.replace("_", "-")
            self.assertEqual(root["--color-" + var], rgb(default), key)
            self.assertEqual(root["--hex-" + var].upper(), default, key)

    def test_the_status_tokens_are_the_settings(self):
        tokens = {}
        for body in blocks(THEME, ":root"):
            tokens.update(declared(body))
        for state in ("ok", "warn", "err"):
            self.assertEqual(tokens.get(f"--ws-status-{state}"), f"var(--color-status-{state})", state)

    def test_tailwind_names_them(self):
        for state in ("ok", "warn", "err"):
            self.assertIn(f'"status-{state}": "rgb(var(--color-status-{state}) / <alpha-value>)"', TAILWIND)

    def test_appearance_has_a_status_group(self):
        self.assertTrue(live_matches(APPEARANCE, r"WSSettings\.card\('Status colours'"))
        for key in STATUS:
            self.assertIn(f"'theme.color_{key}'", APPEARANCE)
            self.assertIn(f"'{key.replace('_', '-')}'", APPEARANCE)
        # The live preview shows each state as the header pill does.
        for state in ("ok", "warn", "err"):
            self.assertIn(f"['{state}', ", APPEARANCE)
        self.assertIn("ws-pill-label", APPEARANCE)


class StatusColourOnlyOnDeviation(unittest.TestCase):
    """Part 5: "online" is quiet theme text; the words take the status colour
    only when something needs attention. The dot and the ring always carry
    the state's token."""

    def test_the_header_pill_is_a_ws_pill(self):
        self.assertRegex(HEADER, r'id="systemStatus" data-state="unknown" class="ws-pill\b')
        self.assertRegex(HEADER, r'data-status-text class="ws-pill-label text-frosted-blue\b')

    def test_marks_follow_every_state(self):
        for state in ("ok", "warn", "err"):
            self.assertIn(f"--ws-pill: var(--ws-status-{state})", css_rule(THEME, f'.ws-pill[data-state="{state}"]'))

    def test_only_warn_and_err_tint_the_words(self):
        for state in ("warn", "err"):
            rule = css_rule(THEME, f'.ws-pill[data-state="{state}"] .ws-pill-label')
            self.assertIn(f"color: rgb(var(--color-status-{state}))", rule)
        self.assertNotRegex(top_level(THEME), r'\[data-state="ok"\][^{,]*(?:ws-pill-label|data-status-text)')


if __name__ == "__main__":
    unittest.main()
