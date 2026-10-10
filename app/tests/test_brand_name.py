"""
The site name beside the logo (branding.show_name): a setting that ships on.

Off, the page renderer leaves the name out of the sidebar's brand block and
the sign-in card, shows the logo in a taller fixed box, and gives the sidebar
logo the name as its alt text; the sign-in page keeps the name in its one h1,
for screen readers only, and its logo is decorative (alt="") so the name is
read once. All of it is in the served HTML, so the first paint is
already right; a soft navigation copies the sidebar's brand block from the
fetched page and a save in Settings patches it through the shell fragment
(the branding. prefix is a shell key). The tab title, the manifest, the
"Add to home screen" row and the data block keep the name either way.
"""
import os
import re
import unittest

from app import pages
from app import settings_registry as reg
from app.tests import helpers
from app.tests.test_pages import branding, data_of, render, static_text

KEY = "branding.show_name"
OFF = {KEY: "false"}
# The lone logo's box (show_name off): the sidebar's whole width inside its border, 144px tall.
ALONE = "-mx-6 -my-2 w-[calc(100%+3rem)] max-w-none h-36"
STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")


def setUpModule():
    pages.STATIC_DIR = STATIC


def brand_block(out):
    m = re.search(r"<div[^>]*data-ws-brand>(.*?)</div>\s*<nav id=\"desktopNav\"", out, re.S)
    assert m, "no brand block"
    return m.group(1)


def login(b):
    return render(user=None, name="login", b=b, page=static_text("login.html"))


def login_logo(out):
    found = re.findall(r'<img id="loginLogo" alt="([^"]*)" class="([^"]*)"', out)
    assert len(found) == 1, found
    return found[0]


def login_h1(out):
    found = re.findall(r'<h1 id="loginAppName" class="([^"]*)">([^<]*)</h1>', out)
    assert len(found) == 1, found
    return found[0]


class Setting(unittest.TestCase):
    def test_registry_ships_it_on(self):
        d = reg.REGISTRY[KEY]
        self.assertEqual((d.type, d.default, d.public, d.seed, d.secret), ("bool", "true", True, True, False))
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
        self.assertIs(branding()["show_name"], True)
        self.assertIs(branding(**OFF)["show_name"], False)
        for odd in ("true", "False", " false", "0", ""):
            self.assertIs(branding(**{KEY: odd})["show_name"], True, odd)


class Sidebar(unittest.TestCase):
    def test_on_by_default_the_name_shows_under_the_logo(self):
        block = brand_block(render(b=branding(**{"branding.app_name": "My Server"})))
        self.assertIn(">My Server</p>", block)
        self.assertIn('alt="Logo" class="w-full h-24 mb-3 rounded-lg object-contain"', block)

    def test_off_the_logo_stands_alone_larger_and_carries_the_name(self):
        block = brand_block(render(b=branding(**{"branding.app_name": "A & B <x>", **OFF})))
        self.assertNotIn("A &amp; B", re.sub(r'alt="[^"]*"', "", block))
        self.assertRegex(block, r'<p class="[^"]*\bhidden\b[^"]*"></p>')
        self.assertIn(f'alt="A &amp; B &lt;x&gt;" class="{ALONE} rounded-lg object-contain"', block)
        self.assertNotIn("<x>", block)

    def test_off_the_logo_takes_the_sidebar_width_and_the_nav_stays_put(self):
        # The lone logo runs the sidebar's whole width inside its border (the
        # block's 24px padding a side given back; it was 12px in from each
        # side) and 144px tall, 8px of it from the padding above and below:
        # the block stays 24 + 128 + 24.
        sidebar = re.search(r'<div class="p-6 flex flex-col items-center" data-ws-brand>',
                            render(b=branding(**OFF)))
        self.assertIsNotNone(sidebar, "the block's own padding is unchanged")
        self.assertEqual(ALONE.split(), ["-mx-6", "-my-2", "w-[calc(100%+3rem)]", "max-w-none", "h-36"])
        app_css = open(os.path.join(STATIC, "css", "app.css"), encoding="utf-8").read()
        # The compiled utilities exist (Tailwind emits only literal classes).
        for rule in (".-mx-6{margin-left:-1.5rem;margin-right:-1.5rem}",
                     ".-my-2{margin-top:-.5rem;margin-bottom:-.5rem}",
                     ".w-\\[calc\\(100\\%\\+3rem\\)\\]{width:calc(100% + 3rem)}",
                     ".max-w-none{max-width:none}", ".h-36{height:9rem}"):
            self.assertIn(rule, app_css, rule)

    def test_off_with_the_default_logo(self):
        b = branding(**{"branding.app_name": "My Server", **OFF})
        self.assertEqual(b["logo_url"], "/static/webservarr.svg")
        self.assertIn(f'<img src="/static/webservarr.svg" alt="My Server" class="{ALONE}',
                      brand_block(render(b=b)))

    def test_off_with_no_logo_the_icon_box_is_named(self):
        block = brand_block(render(b=branding(**{"branding.app_name": "My Server", "branding.logo_url": "", **OFF})))
        self.assertIn('<div role="img" aria-label="My Server" class="size-20 ', block)
        self.assertIn('aria-hidden="true"', block)

    def test_off_with_no_name_the_alt_stays_logo(self):
        block = brand_block(render(b=branding(**{"branding.app_name": "", **OFF})))
        self.assertIn('alt="Logo"', block)

    def test_the_shell_fragment_matches_the_page(self):
        for b in (branding(), branding(**OFF)):
            frag = pages.shell_fragment(b, True, "settings", "WebServarr - Settings")
            self.assertEqual(frag["brand_html"].strip(), brand_block(render(name="settings", b=b)).strip())

    def test_a_save_patches_the_brand_through_the_shell_keys(self):
        kit = static_text("js", "settings", "kit.js")
        m = re.search(r"var SHELL_KEYS = (/[^\n]*/);", kit)
        self.assertRegex(KEY, m.group(1)[1:-1])


class Unchanged(unittest.TestCase):
    def test_title_manifest_install_row_and_payload_keep_the_name(self):
        named = {"branding.app_name": "My Server"}
        on, off = render(b=branding(**named)), render(b=branding(**named, **OFF))
        for out in (on, off):
            self.assertIn("<title>My Server - Control Center</title>", out)
            self.assertIn('property="og:site_name" content="My Server"', out)
            self.assertIn("Open My Server like an app", out)
            self.assertEqual(data_of(out)["branding"]["app_name"], "My Server")
        self.assertEqual(pages.web_manifest(branding(**named))["name"],
                         pages.web_manifest(branding(**named, **OFF))["name"])
        self.assertEqual(pages.web_manifest(branding(**named, **OFF))["name"], "My Server")


class Login(unittest.TestCase):
    def test_on_the_name_is_the_visible_heading(self):
        out = login(branding(**{"branding.app_name": "My Server"}))
        cls, text = login_h1(out)
        self.assertEqual(text, "My Server")
        self.assertNotIn("sr-only", cls.split())
        self.assertNotIn("hidden", cls.split())
        alt, img_cls = login_logo(out)
        self.assertEqual(alt, "Logo")
        self.assertNotIn(pages.LOGIN_LOGO_ALONE_CLS, img_cls.split())
        self.assertIn("h-48", img_cls.split())

    def test_off_one_h1_for_screen_readers_and_the_logo_is_decorative(self):
        out = login(branding(**{"branding.app_name": "A & B <x>", **OFF}))
        self.assertEqual(len(re.findall(r"<h1\b", out)), 1)
        cls, text = login_h1(out)
        self.assertEqual(text, "A &amp; B &lt;x&gt;")
        self.assertIn("sr-only", cls.split())
        self.assertNotIn("hidden", cls.split())
        alt, img_cls = login_logo(out)
        # The sr-only h1 already says the name: the logo is not read a second time.
        self.assertEqual(alt, "")
        self.assertEqual(out.count("A &amp; B &lt;x&gt;", out.index("<body")), 1)
        self.assertIn(pages.LOGIN_LOGO_ALONE_CLS, img_cls.split())
        self.assertIn("h-48", img_cls.split())
        self.assertNotIn("<x>", out.split("<body")[1])
        self.assertIn("<title>A &amp; B &lt;x&gt; - Login</title>", out)

    def test_off_with_no_name_the_heading_stays_hidden(self):
        out = login(branding(**{"branding.app_name": "", **OFF}))
        cls, text = login_h1(out)
        self.assertEqual(text, "")
        self.assertIn("hidden", cls.split())
        self.assertEqual(login_logo(out)[0], "Logo")

    def test_the_footgun_guards_are_untouched(self):
        flat = re.sub(r"\s+", " ", static_text("login.html"))
        self.assertIn("#loginForm { visibility: hidden; }", flat)
        self.assertIn("#loginForm.auth-ready { visibility: visible; }", flat)
        self.assertIn("html:not([data-login-js]) #loginForm { animation: login-fallback-show 0s linear 2.5s forwards; }",
                      flat)
        js = re.sub(r"\s+", " ", static_text("js", "login.js"))
        self.assertIn("var REVEAL_AFTER_MS = 2500;", js)
        self.assertIn("setTimeout(revealForm, REVEAL_AFTER_MS);", js)
        # The served page keeps them too, either way.
        for b in (branding(), branding(**OFF)):
            self.assertIn("#loginForm { visibility: hidden; }", re.sub(r"\s+", " ", login(b)))

    def test_the_script_never_touches_the_name_or_the_alt(self):
        js = static_text("js", "login.js")
        self.assertNotIn("loginAppName", js)
        self.assertNotIn(".alt", js)


class SettingsPage(unittest.TestCase):
    def test_general_tab_has_the_switch_under_the_site_name(self):
        src = static_text("js", "settings", "general.js")
        name = src.index("key: 'branding.app_name', label: 'Site name',")
        switch = src.index("key: 'branding.show_name', label: 'Show site name next to the logo',")
        self.assertLess(name, switch)
        self.assertLess(switch, src.index("key: 'branding.tagline', label: 'Tagline',"))
        self.assertIn("help: 'The name still appears in browser tabs, the home-screen app and notifications.'",
                      src[switch:switch + 300])
        self.assertIn("'branding.show_name'", src[:src.index("var LOGO_TYPES")])


if __name__ == "__main__":
    unittest.main()
