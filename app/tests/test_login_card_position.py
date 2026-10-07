"""
Where the sign-in card sits on a wide screen (login.card_position).

Artwork behind the login page is often framed on its middle, which the card
covers. The setting moves the card to the left or right edge on wide
screens. It ships as Centre, today's look: the page renderer adds no mark,
so a default install serves the page exactly as before. Left and Right are
an <html data-login-card> mark the server writes, so the card is in place
from the first paint and never jumps; login.html's CSS places it from that
mark, only from 64rem up (phones and tablets keep it centred). The card's
glass and the sign-in form's reveal are untouched.
"""
import os
import re
import unittest

from app import pages
from app import settings_registry as reg
from app.tests.test_pages import branding, data_of, html_tag, render, static_text

KEY = "login.card_position"
STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")


def setUpModule():
    pages.STATIC_DIR = STATIC


def login(**settings):
    return render(user=None, name="login", b=branding(**settings), page=static_text("login.html"))


def login_style():
    m = re.search(r"<style>(.*?)</style>", static_text("login.html"), re.S)
    assert m, "no style block"
    return re.sub(r"\s+", " ", m.group(1))


def wide_block(css):
    start = css.index("@media (min-width: 64rem) {")
    depth, i = 0, css.index("{", start)
    for j in range(i, len(css)):
        if css[j] == "{":
            depth += 1
        elif css[j] == "}":
            depth -= 1
            if depth == 0:
                return css[i + 1:j]
    raise AssertionError("unclosed media block")


class Setting(unittest.TestCase):
    def test_registry_ships_centre(self):
        d = reg.REGISTRY[KEY]
        self.assertEqual((d.type, d.default, d.public, d.seed, d.secret), ("enum", "centre", True, True, False))
        self.assertEqual(d.choices, ("centre", "left", "right"))
        self.assertEqual(reg.seed_defaults()[KEY][0], "centre")
        self.assertEqual(reg.public_defaults()[KEY], "centre")

    def test_validation_takes_only_the_choices(self):
        for v in ("centre", "left", "right"):
            self.assertIsNone(reg.validate_value(KEY, v))
        for v in ("", "bottom", "center", "LEFT"):
            self.assertIsNotNone(reg.validate_value(KEY, v))

    def test_branding_default_and_unknown_are_centre(self):
        self.assertEqual(branding()["login_card"], "centre")
        self.assertEqual(branding(**{KEY: "left"})["login_card"], "left")
        self.assertEqual(branding(**{KEY: "right"})["login_card"], "right")
        self.assertEqual(branding(**{KEY: "sideways"})["login_card"], "centre")


class Renderer(unittest.TestCase):
    def test_centre_adds_no_mark(self):
        for out in (login(), login(**{KEY: "centre"}), login(**{KEY: "<x>"})):
            self.assertNotIn("data-login-card", html_tag(out))
            self.assertNotIn("data-login-card=", out.split("<body")[1])

    def test_left_and_right_are_marked_on_html(self):
        for v in ("left", "right"):
            tag = html_tag(login(**{KEY: v}))
            self.assertEqual(tag.count("data-login-card"), 1, tag)
            self.assertIn(f'data-login-card="{v}"', tag)

    def test_only_the_login_page_is_marked(self):
        b = branding(**{KEY: "left"})
        for name in ("index", "settings"):
            self.assertNotIn("data-login-card", html_tag(render(name=name, b=b)))

    def test_the_value_reaches_the_data_block(self):
        self.assertEqual(data_of(login(**{KEY: "right"}))["branding"]["login_card"], "right")


class Css(unittest.TestCase):
    def test_each_position_is_styled_inside_the_wide_block_only(self):
        css = login_style()
        wide = wide_block(css)
        outside = css.replace(wide, "")
        self.assertNotIn("data-login-card", outside)
        self.assertIn('html[data-login-card="left"] main { align-items: flex-start; '
                      'padding-inline-start: var(--login-card-edge); }', wide)
        self.assertIn('html[data-login-card="right"] main { align-items: flex-end; '
                      'padding-inline-end: var(--login-card-edge); }', wide)
        self.assertIn('html[data-login-card="left"] footer { justify-content: start;', wide)
        self.assertIn('html[data-login-card="right"] footer { justify-content: end;', wide)
        self.assertNotIn("centre", wide)

    def test_position_rules_never_touch_the_card_or_form(self):
        wide = wide_block(login_style())
        for sel in (".login-glass-card", "#loginForm", "#loginLoadHint", "backdrop", "visibility", "background",
                    "transition", "animation"):
            self.assertNotIn(sel, wide)

    def test_the_footgun_guards_are_untouched(self):
        flat = re.sub(r"\s+", " ", static_text("login.html"))
        self.assertIn("#loginForm { visibility: hidden; }", flat)
        self.assertIn("#loginForm.auth-ready { visibility: visible; }", flat)
        self.assertIn("html:not([data-login-js]) #loginForm { animation: login-fallback-show 0s linear 2.5s forwards; }",
                      flat)
        js = re.sub(r"\s+", " ", static_text("js", "login.js"))
        self.assertIn("var REVEAL_AFTER_MS = 2500;", js)
        self.assertIn("setTimeout(revealForm, REVEAL_AFTER_MS);", js)
        self.assertNotIn("data-login-card", js)
        for v in ("centre", "left", "right"):
            self.assertIn("#loginForm { visibility: hidden; }", re.sub(r"\s+", " ", login(**{KEY: v})))


class SettingsPage(unittest.TestCase):
    def test_pages_tab_offers_the_choices_in_the_login_expander(self):
        src = static_text("js", "settings", "pages.js")
        self.assertIn("var CARD_KEY = 'login.card_position';", src)
        expander = src[src.index("function loginExpander(api)"):]
        expander = expander[:expander.index("\n  }\n")]
        self.assertIn("body.appendChild(cardPosition(api));", expander)
        for word in ("'Centre'", "'Left'", "'Right'"):
            self.assertIn(word, src)
        # Native radios in a fieldset: the arrow keys move between them.
        self.assertIn("el('fieldset'", src)
        self.assertIn("input.type = 'radio';", src)


if __name__ == "__main__":
    unittest.main()
