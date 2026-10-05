"""
The theme engine: every colour the operator picks reaches the page through
one chain (registry -> branding payload -> the page's #ws-theme and #ws-data
-> theme-loader.js -> theme.css), and the page paints it in the right order.

Run inside the container:
    python -m unittest discover -s /app/app/tests -t /app -v
"""
import json
import re
import unittest
from html.parser import HTMLParser
from unittest import mock

from app.tests.test_motion import css_rule, top_level
from app.tests.test_shell_contract import STATIC, js_code_only, live_matches

THEME = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
LOADER = (STATIC / "js" / "theme-loader.js").read_text(encoding="utf-8")
HEADER = (STATIC / "partials" / "shell-header.html").read_text(encoding="utf-8")
APPEARANCE = (STATIC / "js" / "settings" / "appearance.js").read_text(encoding="utf-8")
UI_JS = (STATIC / "js" / "ui.js").read_text(encoding="utf-8")
NOTIF_JS = (STATIC / "js" / "notifications.js").read_text(encoding="utf-8")
SIDEBAR = (STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8")
KIT = (STATIC / "js" / "settings" / "kit.js").read_text(encoding="utf-8")
FRAME = (STATIC / "settings.html").read_text(encoding="utf-8")
VECTORS = json.loads((STATIC.parent / "tests" / "contrast_vectors.json").read_text(encoding="utf-8"))


def repo_file(test: unittest.TestCase, *parts: str) -> str:
    """A file at the repo root (a checkout, and /app in CI, which copies the
    whole checkout). The dev container mounts only app/, so there the check
    is skipped rather than failed."""
    path = STATIC.parents[1].joinpath(*parts)
    if not path.is_file():
        test.skipTest(f"{'/'.join(parts)} is not in this tree (the dev container mounts only app/)")
    return path.read_text(encoding="utf-8")

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
        cfg = repo_file(self, "tailwind.config.js")
        for state in ("ok", "warn", "err"):
            self.assertIn(f'"status-{state}": "rgb(var(--color-status-{state}) / <alpha-value>)"', cfg)
            # R140: the status-text colours too (text-status-ok-text, ...).
            self.assertIn(f'"status-{state}-text": "var(--ws-status-{state}-text)"', cfg)

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
            self.assertIn(f"color: var(--ws-status-{state}-text)", rule)
        self.assertNotRegex(top_level(THEME), r'\[data-state="ok"\][^{,]*(?:ws-pill-label|data-status-text)')


class DerivedStatusText(unittest.TestCase):
    """R140: status WORDS are the status colour mixed with the text colour, so
    they keep the state's hue and still clear 4.5:1 on the operator's own
    background, light or dark. The pure status colours stay for marks."""

    MIX = "color-mix(in srgb, rgb(var(--ws-status-{s})) 40%, rgb(var(--color-text)))"

    def supports_block(self) -> str:
        m = re.search(r"@supports \(color: color-mix\(in srgb, red 50%, blue\)\) \{\s*"
                      r":root, \[data-ws-theme-preview\] \{([^{}]*)\}\s*\}", THEME)
        self.assertIsNotNone(m, "no @supports block switching the mix on")
        return m.group(1)

    def test_plain_text_is_the_fallback(self):
        # Without color-mix() the words are the text colour, never unset.
        tokens = {}
        for body in blocks(THEME, ":root"):
            tokens.update(declared(body))
        preview = declared(blocks(THEME, "[data-ws-theme-preview]")[0])
        for s in ("ok", "warn", "err"):
            self.assertEqual(tokens.get(f"--ws-status-{s}-text"), "rgb(var(--color-text))", s)
            self.assertEqual(preview.get(f"--ws-status-{s}-text"), "rgb(var(--color-text))", s)

    def test_the_mix_applies_where_supported_and_after_the_fallbacks(self):
        got = declared(self.supports_block())
        for s in ("ok", "warn", "err"):
            self.assertEqual(got.get(f"--ws-status-{s}-text"), self.MIX.format(s=s), s)
        # Same specificity as the preview card's fallback, so it must come later.
        self.assertGreater(THEME.index("@supports (color: color-mix("), THEME.index("[data-ws-theme-preview] {"))

    def test_no_css_paints_words_in_a_pure_status_colour(self):
        self.assertNotRegex(THEME, r"(?<![-\w])color:\s*rgb\(var\(--(?:color|ws)-status-")



def nav_new_badge_rule() -> str:
    return css_rule(THEME, ".nav-new-badge")


class NewFlagIsATheme(unittest.TestCase):
    """M9: the New! flag's colour was a default only (theme-loader read a key
    the server never sent). It is now a theme option like the media colours,
    and every colour in the flag is derived from it: no fixed golds, and no
    outline in the background colour (it vanished on a light page)."""

    @unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
    def test_registry_payload_and_inline_theme(self):
        d = REGISTRY["theme.color_new_flag"]
        self.assertEqual((d.type, d.default, d.public), ("color", "#FFD60A", True))
        b = payload({"theme.color_new_flag": "#22D3EE"})
        self.assertEqual(b["colors"]["new_flag"], "#22D3EE")
        self.assertEqual(payload({"theme.color_new_flag": "gold"})["colors"]["new_flag"], "#FFD60A")
        self.assertIn("--color-new-flag:34 211 238", pages.theme_style(b))

    def test_every_colour_in_the_flag_comes_from_its_setting(self):
        rule = nav_new_badge_rule()
        self.assertNotRegex(rule, r"rgb\(\s*\d", "a fixed colour in the flag")
        self.assertNotIn("--color-background", rule)
        self.assertGreaterEqual(rule.count("rgb(var(--color-new-flag))"), 4)
        self.assertIn("-webkit-text-stroke: 1.25px var(--ws-new-flag-edge)", rule)
        self.assertRegex(rule, r"--ws-new-flag-edge:\s*color-mix\(in srgb, rgb\(var\(--color-new-flag\)\) \d+%, black\)")

    def test_appearance_offers_it_and_previews_it(self):
        self.assertIn("'theme.color_new_flag'", APPEARANCE)
        self.assertIn("'new-flag'", APPEARANCE)
        self.assertIn("'nav-new-badge'", APPEARANCE)



class MotionFollowsTheTheme(unittest.TestCase):
    """L3: the hover lift's shadow and the pill's live ring stay visible on a
    light theme. Both are derived from theme colours: the shadow is the
    background mixed toward black (black on the shipped black page, as before;
    a grey shadow on a white one), the ring is the state's colour pulled
    toward the text colour, which contrasts with the page by construction."""

    def test_the_shade_is_the_background_darkened(self):
        tokens = {}
        for body in blocks(THEME, ":root"):
            tokens.update(declared(body))
        self.assertRegex(tokens.get("--ws-shade", ""),
                         r"^color-mix\(in srgb, rgb\(var\(--color-background\)\) \d+%, black\)$")

    def test_the_lift_shadow_uses_the_shade(self):
        # The one hover rule (inside the pointer media query).
        found = re.findall(r"\.ws-lift:hover \{([^}]*)\}", THEME)
        self.assertEqual(len(found), 1)
        hover = found[0]
        self.assertIn("box-shadow: 0 6px 14px -8px color-mix(in srgb, var(--ws-shade) 90%, transparent)", hover)
        self.assertNotIn("--color-background", hover)

    def test_the_ring_is_pulled_toward_the_text_colour(self):
        found = blocks(THEME, ".ws-status-dot::after")
        self.assertEqual(len(found), 1)
        ring = " ".join(found[0].split())
        self.assertIn("background: color-mix(in srgb, rgb(var(--ws-pill, var(--ws-status-off))) 75%, "
                      "rgb(var(--color-text)))", ring)
        self.assertNotIn("inherit", ring)


class OneScrim(unittest.TestCase):
    """L4: the WSUI dialog, the phone drawer and the notification preferences
    dim the page with one token, derived from the background colour."""

    def test_the_scrim_is_the_background(self):
        self.assertIn("background-color: rgb(var(--color-background) / .7)", css_rule(THEME, ".ws-scrim"))

    def test_every_shared_backdrop_uses_it(self):
        self.assertRegex(UI_JS, r"el\('div', 'ws-dialog [^;]*?\bws-scrim\b")
        self.assertNotIn("bg-background-dark/70", UI_JS)
        # The phone's More sheet dims with the same colour (theme.css).
        scrim = re.search(r"\n\.ws-sheet-scrim \{([^}]*)\}", THEME).group(1)
        self.assertIn("background: rgb(var(--color-background) / .7)", scrim)
        self.assertRegex(NOTIF_JS, r"_modal = createEl\('div', '[^']*\bws-scrim\b")
        self.assertNotRegex(NOTIF_JS, r"_modal\.style\.backgroundColor")



PAGE = (
    '<!DOCTYPE html><html class="dark" lang="en"><head><meta charset="utf-8"/>'
    '<title>WebServarr - Control Center</title>'
    '<script src="/static/js/theme-loader.js?v=1"></script>'
    '<link href="/static/css/app.css?v=1" rel="stylesheet"/>'
    '<link href="/static/css/theme.css?v=1" rel="stylesheet"/>'
    '<style>.page-own { color: rgb(var(--color-text)); }</style></head>'
    '<body><main><p>hi</p></main></body></html>'
)


def render(b, name="index"):
    return pages.render_html(PAGE, name=name, branding=b, user=None, version="9.9.9",
                             base_url="https://example.test", path="/", flags={})


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class CustomCssComesLast(unittest.TestCase):
    """M15: custom CSS used to be injected by theme-loader.js while <head> was
    still parsing, before app.css, theme.css and the page's own styles, so an
    ordinary rule never won. The server now writes it as the last thing in
    <head>, with every "<" as its CSS escape so it can't close its element."""

    def test_it_is_the_last_thing_in_head(self):
        out = render(payload({"theme.custom_css": ".text-frosted-blue { color: red; }"}))
        head = out.split("</head>")[0]
        style = '<style id="webservarr-custom-css">.text-frosted-blue { color: red; }</style>'
        self.assertEqual(out.count('id="webservarr-custom-css"'), 1)
        self.assertTrue(head.rstrip().endswith(style), head[-200:])
        for earlier in ('href="/static/css/app.css', 'href="/static/css/theme.css', '<style>.page-own',
                        '<style id="ws-theme">', 'id="ws-font"'):
            self.assertLess(head.index(earlier), head.index(style), earlier)

    def test_it_cannot_close_its_element(self):
        # R141: a <style> is raw text that ends only at "</style" (any case),
        # so "</" is written "<\\/" (the same characters to CSS) and nothing
        # else changes. A parser then sees exactly one style element holding
        # the whole CSS, and none of the tags inside it.
        css = "/* </style><script>alert(1)</script> */ a::after { content: \"<\"; } </STYLE ><b> </sTyLe\t>"
        out = render(payload({"theme.custom_css": css}))
        m = re.search(r'<style id="webservarr-custom-css">(.*?)</style>', out, re.S)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), css.replace("</", "<\\/"))
        self.assertNotIn("</", m.group(1))
        self.assertIn('content: "<"', m.group(1))

        class Tags(HTMLParser):
            def __init__(self):
                super().__init__()
                self.tags, self.styles, self._in = [], [], None

            def handle_starttag(self, tag, attrs):
                self.tags.append(tag)
                self._in = dict(attrs).get("id") if tag == "style" else None

            def handle_data(self, data):
                if self._in == "webservarr-custom-css":
                    self.styles.append(data)

            def handle_endtag(self, tag):
                self._in = None

        t = Tags()
        t.feed(out)
        self.assertNotIn("b", t.tags)
        self.assertEqual(t.tags.count("script"), 2, "only theme-loader and #ws-data")
        self.assertEqual("".join(t.styles), m.group(1))

    def test_range_queries_are_kept_as_written(self):
        # Media and container query range syntax uses a bare "<"; escaping it
        # stopped the rule from ever applying.
        css = ("@media (400px < width < 9000px) { .x { color: red; } }\n"
               "@container (width < 30em) { .y { color: blue; } }")
        out = render(payload({"theme.custom_css": css}))
        self.assertIn(f'<style id="webservarr-custom-css">{css}</style>', out)

    def test_no_custom_css_no_element(self):
        for css in ("", "   \n"):
            self.assertNotIn("webservarr-custom-css", render(payload({"theme.custom_css": css})))

    def test_the_loader_injects_it_only_on_the_fallback_path(self):
        # The page already carries it; on the /api/branding fallback there is
        # no server copy, so the loader adds it (after everything, by then).
        self.assertTrue(live_matches(LOADER, r"applyTheme\(inline\.branding \|\| \{\}, true\)"))
        self.assertTrue(live_matches(LOADER, r"if \(data\.custom_css && !fromPage\)"))
        self.assertTrue(live_matches(LOADER, r"\.then\(function \(data\) \{ applyTheme\(data, false\); \}\)"))
        self.assertTrue(live_matches(LOADER, r"el\.textContent = data\.custom_css"))



def kit_color_control() -> str:
    """api.color in kit.js, as written."""
    m = re.search(r"\n    api\.color = function \(o\) \{.*?\n    \};\n", KIT, re.S)
    assert m, "api.color not found"
    return m.group(0)


class SettingsShowsTheColourInUse(unittest.TestCase):
    """L8: a stored colour that isn't #rrggbb (an old or hand-edited row) is
    replaced by its default everywhere the site paints (safe_color). The
    colour field used to show the raw text and a black swatch, which is
    neither. It now shows the default the site uses and says the saved value
    isn't a colour; nothing is staged until the admin changes it."""

    def test_the_field_paints_the_default_for_a_stored_value_that_is_not_a_colour(self):
        ctl = kit_color_control()
        self.assertTrue(live_matches(ctl, r"var stored = v === baseline\(o\.key\) && !HEX\.test\(v\);"))
        self.assertTrue(live_matches(ctl, r"var shown = stored \? inUse\(\) : v;"))
        self.assertTrue(live_matches(ctl, r"hex\.value = shown;"))
        # The default comes from the registry meta, never a copy in the page.
        self.assertTrue(live_matches(ctl, r"var m = metaFor\(o\.key\);"))
        self.assertNotRegex(ctl, r"#[0-9a-fA-F]{6}")

    def test_it_says_so_and_stages_nothing(self):
        ctl = kit_color_control()
        self.assertIn("isn’t a colour, so your site uses this one.", ctl)
        self.assertTrue(live_matches(ctl, r"stale\.classList\.toggle\('hidden', !stored\)"))
        self.assertTrue(live_matches(ctl, r"stale\.appendChild\(document\.createTextNode\("))
        # Painting never stages: only the admin's own input does.
        set_fn = re.search(r"set: function \(v\) \{(.*?)\n        \}", ctl, re.S).group(1)
        self.assertNotIn("stage(", set_fn)
        # Typing a new value is the fix: the note goes.
        self.assertTrue(live_matches(ctl, r"stale\.classList\.add\('hidden'\)"))



def _lin(c: int) -> float:
    c = c / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def wcag(a: str, b: str) -> float:
    """WCAG 2 contrast of two #rrggbb colours: the reference appearance.js is held to."""
    def lum(h):
        r, g, bl = (int(h[i:i + 2], 16) for i in (1, 3, 5))
        return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(bl)
    x, y = lum(a), lum(b)
    return (max(x, y) + 0.05) / (min(x, y) + 0.05)


def tinted(fg: str, bg: str, alpha: float) -> str:
    f = [int(fg[i:i + 2], 16) for i in (1, 3, 5)]
    g = [int(bg[i:i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join("%02X" % round(f[k] * alpha + g[k] * (1 - alpha)) for k in range(3))


class ContrastGuard(unittest.TestCase):
    """M14: Appearance measures the pairs that matter as colours change and
    says plainly when one is hard to read; saving text that is very hard to
    read on the background asks first, and never refuses."""

    def test_the_shared_vectors_are_right(self):
        # appearance.js is checked against these by app/tests/js/contrast.mjs.
        self.assertGreaterEqual(len(VECTORS["cases"]), 15)
        for c in VECTORS["cases"]:
            self.assertAlmostEqual(wcag(c["fg"], c["bg"]), c["ratio"], places=3, msg=c["why"])
        for t in VECTORS["tints"]:
            self.assertEqual(tinted(t["fg"], t["bg"], t["alpha"]), t["tint"])
            self.assertAlmostEqual(wcag(t["fg"], t["tint"]), t["ratio"], places=3)
        # The shipped palette passes everything it is checked for.
        self.assertGreater(wcag("#BEEEF4", "#000000"), 7)
        self.assertGreater(wcag("#FFFFFF", "#125793"), 4.5)

    def test_ci_runs_the_js_check(self):
        self.assertIn("node app/tests/js/contrast.mjs", repo_file(self, ".github", "workflows", "docker-publish.yml"))

    def test_the_pairs_and_their_thresholds(self):
        for fg, bg, minimum in (("text", "background", "4.5"), ("text_secondary", "background", "4.5"),
                                ("text_secondary", "primary", "4.5"), ("new_flag", "background", "3")):
            self.assertRegex(APPEARANCE, rf"fg: 'theme\.color_{fg}', bg: 'theme\.color_{bg}',[^}}]*min: {minimum}\b",
                             (fg, bg))
        for key in ("media_movie", "media_tv", "media_book"):
            self.assertRegex(APPEARANCE, rf"fg: 'theme\.color_{key}', bg: 'theme\.color_background', badge: true,[^}}]*min: 4\.5")
        for key in ("status_ok", "status_warn", "status_err"):
            self.assertRegex(APPEARANCE, rf"fg: 'theme\.color_{key}', bg: 'theme\.color_background',[^}}]*min: 4\.5")

    def test_it_measures_the_colour_in_use(self):
        # A stored value that isn't a colour is measured as the default the site uses (L8).
        self.assertTrue(live_matches(APPEARANCE, r"function inUse\(api, key\) \{ return api\.colorInUse\(key\); \}"))
        rule = re.search(r"api\.colorInUse = function \(key\) \{(.*?)\n    \};", KIT, re.S)
        self.assertIsNotNone(rule)
        self.assertIn("if (HEX.test(v)) return v;", rule.group(1))
        self.assertIn("var m = metaFor(key);", rule.group(1))

    def test_saving_very_hard_to_read_text_asks_first(self):
        self.assertTrue(live_matches(APPEARANCE, r"api\.beforeSave\(function \(keys\) \{"))
        self.assertTrue(live_matches(APPEARANCE, r"if \(ratio >= 3\) return true;"))
        self.assertIn("This makes text hard to read. Save anyway?", APPEARANCE)
        self.assertIn("/settings?theme=safe#appearance", APPEARANCE)
        self.assertRegex(APPEARANCE, r"confirmLabel: 'Save anyway', cancelLabel: 'Keep editing'")


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class SafeColours(unittest.TestCase):
    """M14's way back from an unreadable theme: /settings?theme=safe (admins
    only; Settings is admin-only anyway) renders Settings in the shipped
    colours and font, without the custom CSS, and says so. Nothing is saved
    or changed by visiting it."""

    def test_the_render_uses_the_shipped_theme(self):
        b = payload({"theme.color_text": "#3A3A3A", "theme.color_background": "#3A3A3A",
                     "theme.font": "Libre Barcode 39", "theme.custom_css": "body { display: none; }"})
        out = pages.render_html(PAGE, name="settings", branding=pages.safe_theme_branding(b), user=None,
                                version="9.9.9", base_url="https://example.test", path="/settings",
                                flags={"safe_theme": True})
        self.assertIn("--color-text:190 238 244", out)
        self.assertIn("--color-background:0 0 0", out)
        self.assertIn('--font-display:"Spline Sans"', out)
        self.assertNotIn("webservarr-custom-css", out)
        self.assertIn(" data-safe-theme", re.search(r"<html\b[^>]*>", out).group(0))
        # The saved custom CSS is still in the data block: the Appearance
        # skeleton opens the Custom CSS section by it, as the tab does.
        self.assertEqual(json.loads(re.search(r'id="ws-data" type="application/json">(.*?)</script>', out).group(1)
                                    .replace("\\u003c", "<"))["branding"]["custom_css"], "body { display: none; }")

    def test_the_route(self):
        from app.tests.test_page_gating import ADMIN_SESSION, MEMBER_SESSION, PageRoutesBase

        class Routes(PageRoutesBase):
            def runTest(self):
                pass
        r = Routes()
        r.setUp()
        try:
            saved = {"theme.color_primary": "#FF00FF", "theme.custom_css": "a { color: red; }"}
            with mock.patch.object(pages, "STATIC_DIR", str(STATIC)):
                safe = r.get("/settings?theme=safe", ADMIN_SESSION, saved)
                plain = r.get("/settings", ADMIN_SESSION, saved)
                member = r.get("/settings?theme=safe", MEMBER_SESSION, saved)
        finally:
            r.tearDown()
        self.assertEqual(safe.status_code, 200)
        self.assertIn("--color-primary:18 87 147", safe.text)
        self.assertNotIn("webservarr-custom-css", safe.text)
        self.assertIn(" data-safe-theme", re.search(r"<html\b[^>]*>", safe.text).group(0))
        self.assertIn("--color-primary:255 0 255", plain.text)
        self.assertIn('<style id="webservarr-custom-css">', plain.text)
        self.assertNotIn("data-safe-theme", re.search(r"<html\b[^>]*>", plain.text).group(0))
        self.assertEqual(member.status_code, 302)

    def test_the_page_says_so_and_offers_the_way_out(self):
        notice = re.search(r'<div id="safeThemeNotice"[^>]*>(.*?)</div>', FRAME, re.S)
        self.assertIsNotNone(notice)
        self.assertIn('href="/settings#appearance"', notice.group(1))
        self.assertIn("html:not([data-safe-theme]) #safeThemeNotice { display: none; }", THEME)

    def test_the_preview_stays_in_its_card_in_safe_colours(self):
        # In safe colours the page must stay readable, so a colour being
        # edited restyles only the preview cards, not the page.
        ctl = kit_color_control()
        # Read on each visit (soft navigation): the kit's init, from the page's flags.
        self.assertTrue(live_matches(KIT, r"\n    SAFE = document\.documentElement\.hasAttribute\('data-safe-theme'\);"))
        self.assertTrue(live_matches(ctl, r"if \(SAFE\) \{ scopedPreview\(o\.cssVar, v\); return; \}"))
        self.assertTrue(live_matches(APPEARANCE, r"box\.setAttribute\('data-ws-theme-preview', ''\)"))
        self.assertIn("[data-ws-theme-preview]", THEME)


# Home's gauges (R189): the rings wear the accent unless Colourful gauges is
# on, then their original colours (v1.10.11's Tailwind cyan, purple, orange).
GAUGES = {"gauge_cpu": "#06B6D4", "gauge_ram": "#A855F7", "gauge_net": "#F97316"}
INDEX = (STATIC / "index.html").read_text(encoding="utf-8")


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class GaugeColours(unittest.TestCase):
    """A switch and three colours, carried like every theme colour: registry,
    payload, #ws-theme, the loader, theme.css defaults and Appearance. The
    server picks the rings' colour at render time, so there is no flash."""

    def ws_theme(self, values=None) -> dict:
        style = pages.theme_style(payload(values))
        return declared(re.search(r'<style id="ws-theme">:root\{(.*)\}</style>', style).group(1))

    def test_registry_rows(self):
        d = REGISTRY["theme.gauges_colourful"]
        self.assertEqual((d.type, d.default, d.public), ("bool", "false", True))
        for key, default in GAUGES.items():
            with self.subTest(key):
                d = REGISTRY["theme.color_" + key]
                self.assertEqual((d.type, d.default, d.public, d.allow_empty), ("color", default, True, False))
                self.assertIsNotNone(settings_registry.validate_value(d.key, "orange"))
        self.assertEqual(settings_registry.GAUGE_IDS, ("cpu", "ram", "net"))

    def test_they_are_seeded_and_served_as_defaults(self):
        for key, default in dict(GAUGES, gauges_colourful="false").items():
            full = ("theme.color_" + key) if key != "gauges_colourful" else "theme." + key
            self.assertEqual(seed.DEFAULT_SETTINGS[full][0], default, full)
            self.assertEqual(BRANDING_DEFAULTS[full], default, full)

    def test_the_payload_carries_the_switch_and_safe_colours(self):
        self.assertIs(payload()["gauges_colourful"], False)
        self.assertIs(payload({"theme.gauges_colourful": "true"})["gauges_colourful"], True)
        for odd in ("TRUE", "yes", "1", ""):
            self.assertIs(payload({"theme.gauges_colourful": odd})["gauges_colourful"], False, odd)
        colors = payload({"theme.color_gauge_cpu": "#123456", "theme.color_gauge_ram": "purple",
                          "theme.color_gauge_net": "#F97316;x"})["colors"]
        self.assertEqual(colors["gauge_cpu"], "#123456")
        self.assertEqual(colors["gauge_ram"], GAUGES["gauge_ram"])
        self.assertEqual(colors["gauge_net"], GAUGES["gauge_net"])

    def test_off_the_rings_wear_the_accent(self):
        # Exactly v1.11.0's look: the rings were text-steel-blue (the accent).
        got = self.ws_theme({"theme.color_accent": "#336699"})
        for g in ("cpu", "ram", "net"):
            self.assertEqual(got["--ws-gauge-" + g], "var(--color-accent)", g)
            self.assertEqual(got["--color-gauge-" + g], rgb(GAUGES["gauge_" + g]), g)   # still sent as saved
        self.assertEqual(got["--color-accent"], "51 102 153")

    def test_on_each_ring_wears_its_own_colour(self):
        got = self.ws_theme({"theme.gauges_colourful": "true", "theme.color_gauge_ram": "#123456"})
        for g in ("cpu", "ram", "net"):
            self.assertEqual(got["--ws-gauge-" + g], f"var(--color-gauge-{g})", g)
        self.assertEqual(got["--color-gauge-cpu"], "6 182 212")
        self.assertEqual(got["--color-gauge-ram"], "18 52 86")
        self.assertEqual(got["--hex-gauge-net"], GAUGES["gauge_net"])

    def test_only_the_payloads_own_true_turns_them_on(self):
        for odd in ("true", 1, None):
            style = pages.theme_style(dict(payload(), gauges_colourful=odd))
            self.assertIn("--ws-gauge-cpu:var(--color-accent)", style, odd)

    def test_safe_colours_keep_the_switch_and_ship_the_colours(self):
        b = payload({"theme.gauges_colourful": "true", "theme.color_gauge_cpu": "#010203",
                     "theme.color_accent": "#010203"})
        safe = pages.safe_theme_branding(b)
        self.assertIs(safe["gauges_colourful"], True)        # the skeleton shows the pickers by it
        style = pages.theme_style(safe)
        self.assertNotIn("1 2 3", style)
        self.assertIn("--color-gauge-cpu:6 182 212", style)
        self.assertIn("--ws-gauge-cpu:var(--color-gauge-cpu)", style)

    def test_stylesheet_defaults(self):
        root = declared(blocks(THEME, ":where(:root)")[0])
        for key, default in GAUGES.items():
            var = key.replace("_", "-")
            self.assertEqual(root["--color-" + var], rgb(default), key)
            self.assertEqual(root["--hex-" + var].upper(), default, key)
        for g in ("cpu", "ram", "net"):
            self.assertEqual(root["--ws-gauge-" + g], "var(--color-accent)", g)

    def test_the_loader_picks_as_the_server_does(self):
        self.assertIn("['cpu', 'ram', 'net'].forEach(function (g) {", LOADER)
        self.assertTrue(live_matches(
            LOADER, r"data\.gauges_colourful === true \? 'var\(--color-gauge-' \+ g \+ '\)' : 'var\(--color-accent\)'"))
        self.assertTrue(live_matches(LOADER, r"setProperty\('--ws-gauge-' \+ g,"))

    def test_tailwind_names_them(self):
        cfg = repo_file(self, "tailwind.config.js")
        for g in ("cpu", "ram", "net"):
            self.assertIn(f'"gauge-{g}": "rgb(var(--ws-gauge-{g}) / <alpha-value>)"', cfg)

    def test_the_rings_use_them(self):
        for g in ("cpu", "ram", "net"):
            # One copy: the headers' template (Home clones it into each).
            rings = re.findall(rf'<circle data-gauge-ring="{g}" class="([^"]*)"', INDEX)
            self.assertEqual(len(rings), 1, g)
            for ring in rings:
                self.assertEqual(ring.split()[0], f"text-gauge-{g}", g)
                self.assertNotIn("steel-blue", ring, g)
            # The compiled utility exists (Tailwind emits only literal classes).
            self.assertIn(f".text-gauge-{g}{{", (STATIC / "css" / "app.css").read_text(encoding="utf-8"))

    def test_appearance_offers_the_switch_and_its_pickers(self):
        self.assertIn("var GAUGES_ON = 'theme.gauges_colourful';", APPEARANCE)
        for key, var in (("gauge_cpu", "gauge-cpu"), ("gauge_ram", "gauge-ram"), ("gauge_net", "gauge-net")):
            self.assertRegex(APPEARANCE, rf"\['theme\.color_{key}', '[^']+', '{var}'\]")
        self.assertTrue(live_matches(APPEARANCE, r"WSSettings\.card\('Home gauges'\)"))
        self.assertTrue(live_matches(APPEARANCE, r"api\.toggle\(\{ key: GAUGES_ON, label: 'Colourful gauges',"))
        self.assertTrue(live_matches(APPEARANCE, r"api\.color\(\{ key: g\[0\], label: g\[1\], cssVar: g\[2\] \}\)"))
        # The pickers show only while the switch is on (or hold a change).
        self.assertTrue(live_matches(APPEARANCE, r"var open = api\.get\(GAUGES_ON\) === 'true' \|\|"))
        self.assertTrue(live_matches(APPEARANCE, r"ggrid\.classList\.toggle\('hidden', !open\);"))

    def test_reset_stages_them_too(self):
        keys = re.search(r"var KEYS = (.*?);\n", APPEARANCE, re.S).group(1)
        self.assertIn("[GAUGES_ON]", keys)
        self.assertIn("GAUGES.map(function (g) { return g[0]; })", keys)

    def test_the_contrast_guard_leaves_the_rings_alone(self):
        # Rings are non-text marks; the guard measures text (and the New!
        # flag's lettering at 3:1), so gauges are not among its pairs.
        pairs = re.search(r"var PAIRS = \[(.*?)\n  \];", APPEARANCE, re.S).group(1)
        self.assertNotIn("gauge", pairs)

    def test_the_skeleton_has_both_states(self):
        panel = FRAME[FRAME.index('<section id="panel-appearance"'):]
        panel = panel[:panel.index("</section>")]
        card = panel[panel.index('<span class="skel-text">Home gauges</span>'):panel.index(
            '<span class="skel-text">Status colours</span>')]
        self.assertIn('<span class="skel-text">Colourful gauges</span>', card)
        self.assertIn('<span class="skel block w-11 h-6 rounded-full shrink-0"></span>', card)
        pickers = card[card.index('<div data-skel-when="gauges-on" hidden>'):]
        self.assertEqual(re.findall(r'<span class="skel-text">([^<]+)</span>', pickers), ["CPU", "RAM", "Network"])
        self.assertIn('<div class="grid sm:grid-cols-3 gap-5 max-w-2xl">', pickers)


if __name__ == "__main__":
    unittest.main()
