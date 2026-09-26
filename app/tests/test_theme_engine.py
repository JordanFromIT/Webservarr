"""
The theme engine: every colour the operator picks reaches the page through
one chain (registry -> branding payload -> the page's #ws-theme and #ws-data
-> theme-loader.js -> theme.css), and the page paints it in the right order.

Run inside the container:
    python -m unittest discover -s /app/app/tests -t /app -v
"""
import re
import unittest

from app.tests.test_motion import top_level
from app.tests.test_shell_contract import STATIC

THEME = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")

try:
    from app import pages
    from app.routers.branding import build_branding
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


if __name__ == "__main__":
    unittest.main()
