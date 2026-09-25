"""
The theme values in the branding payload are sanitised where it is built.

build_branding is the one builder for /api/branding and each page's inline
#ws-data block, and theme-loader.js applies its font and colours as inline
styles on <html>, over the server's own #ws-theme rule. So a legacy or
hand-edited row (a font with a quote in it, a colour that isn't #rrggbb) must
be replaced by its registry default here, with the same rule the page
renderer uses for #ws-theme and #ws-font, or it breaks every page.
"""
import json
import unittest

try:
    from fastapi.testclient import TestClient

    from app import pages, settings_registry
    from app.database import get_db
    from app.dependencies import get_current_user_optional
    from app.limiter import limiter
    from app.main import app
    from app.models import Setting
    from app.routers import branding
    from app.routers.branding import EMPTY_WIKI_HOOKS, build_branding
    from app.settings_registry import REGISTRY
    from app.tests.test_push import make_session_factory
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

COLOR_KEYS = ("primary", "secondary", "accent", "text", "text_secondary", "background",
              "media_movie", "media_tv", "media_book")
BAD_FONTS = ('Weird"Font', "Foo\\Bar", "not;a font", "Evil\"; @import url(x)", "a" * 61, "", "   ",
             "Font\nName", "Roboto</style>")
BAD_COLORS = ("#12", "red", "#12345G", "125793", "#1257930", "#125793\n", " #125793", "rgb(1,2,3)", "")


def payload(values):
    return build_branding(values, {}, None, dict(EMPTY_WIKI_HOOKS))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ThemePayload(unittest.TestCase):
    def test_a_bad_font_becomes_the_registry_default(self):
        for bad in BAD_FONTS:
            with self.subTest(font=bad):
                self.assertEqual(payload({"theme.font": bad})["font"], REGISTRY["theme.font"].default)

    def test_a_good_font_passes_trimmed(self):
        for good in ("Exo 2", "Source Sans 3", "Spline Sans", "Red Hat Display", "Atkinson Hyperlegible"):
            with self.subTest(font=good):
                self.assertEqual(payload({"theme.font": good})["font"], good)
        self.assertEqual(payload({"theme.font": "  Inter  "})["font"], "Inter")

    def test_each_bad_colour_becomes_its_own_registry_default(self):
        for key in COLOR_KEYS:
            for bad in BAD_COLORS:
                with self.subTest(key=key, value=bad):
                    self.assertEqual(payload({"theme.color_" + key: bad})["colors"][key],
                                     REGISTRY["theme.color_" + key].default)

    def test_each_media_colour_is_checked(self):
        # The three media accents are separate keys with separate defaults.
        got = payload({"theme.color_media_movie": "NaN", "theme.color_media_tv": "#zzzzzz",
                       "theme.color_media_book": "#FFF"})["colors"]
        for key in ("media_movie", "media_tv", "media_book"):
            self.assertEqual(got[key], REGISTRY["theme.color_" + key].default, key)

    def test_good_colours_pass_as_stored(self):
        for key in COLOR_KEYS:
            with self.subTest(key=key):
                self.assertEqual(payload({"theme.color_" + key: "#c0392B"})["colors"][key], "#c0392B")

    def test_the_payload_shape_is_unchanged(self):
        p = payload({})
        self.assertEqual(list(p["colors"]), list(COLOR_KEYS))
        self.assertEqual({k: p["colors"][k] for k in COLOR_KEYS},
                         {k: REGISTRY["theme.color_" + k].default for k in COLOR_KEYS})
        self.assertEqual(p["font"], REGISTRY["theme.font"].default)

    def test_the_inline_data_block_carries_the_safe_values(self):
        b = payload({"theme.font": 'Weird"Font', "theme.color_primary": "#1x3y5z"})
        block = pages.data_block(b, None, "1.0.0", "index")
        data = json.loads(block.split(">", 1)[1].rsplit("<", 1)[0])
        self.assertEqual(data["branding"]["font"], REGISTRY["theme.font"].default)
        self.assertEqual(data["branding"]["colors"]["primary"], REGISTRY["theme.color_primary"].default)
        self.assertNotIn("Weird", block)
        self.assertNotIn("1x3y5z", block)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class OneRule(unittest.TestCase):
    """The payload and the page renderer share one helper, so they can't drift."""

    def test_pages_and_branding_use_the_registry_helpers(self):
        self.assertIs(branding.safe_font, settings_registry.safe_font)
        self.assertIs(branding.safe_color, settings_registry.safe_color)
        self.assertIs(pages.safe_font, settings_registry.safe_font)
        self.assertIs(pages.safe_color, settings_registry.safe_color)
        # No second copy of either rule in the renderer.
        self.assertFalse(hasattr(pages, "_FONT"))
        self.assertFalse(hasattr(pages, "_HEX"))

    def test_the_font_rule_is_the_registry_pattern(self):
        d = REGISTRY["theme.font"]
        for value in BAD_FONTS + ("Exo 2", "Inter"):
            with self.subTest(value=value):
                valid = settings_registry.validate_value("theme.font", value.strip()) is None and value.strip() != ""
                expect = value.strip() if valid else d.default
                self.assertEqual(settings_registry.safe_font(value), expect)

    def test_renderer_and_payload_agree(self):
        for values in ({"theme.font": 'Weird"Font', "theme.color_accent": "#12"},
                       {"theme.font": "Exo 2", "theme.color_media_book": "#abcdef"}, {}):
            with self.subTest(values=values):
                b = payload(values)
                style = pages.theme_style(b)
                self.assertIn(f'--font-display:"{b["font"]}",sans-serif', style)
                for key in COLOR_KEYS:
                    self.assertIn(f'--hex-{key.replace("_", "-")}:{b["colors"][key]}', style)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class PublicEndpoint(unittest.TestCase):
    def setUp(self):
        self.Session = make_session_factory()

        def _db():
            db = self.Session()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[get_current_user_optional] = lambda: None
        self._limiter_was = limiter.enabled
        limiter.enabled = False
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()
        limiter.enabled = self._limiter_was

    def _store(self, rows):
        db = self.Session()
        try:
            for k, v in rows.items():
                db.add(Setting(key=k, value=v))
            db.commit()
        finally:
            db.close()

    def test_api_branding_carries_the_safe_values(self):
        rows = {"theme.font": 'Weird"Font'}
        rows.update({"theme.color_" + k: "NaN" for k in COLOR_KEYS})
        self._store(rows)
        r = self.client.get("/api/branding")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual(data["font"], REGISTRY["theme.font"].default)
        for key in COLOR_KEYS:
            self.assertEqual(data["colors"][key], REGISTRY["theme.color_" + key].default, key)
        self.assertNotIn("Weird", r.text)
        self.assertNotIn("NaN", r.text)

    def test_api_branding_keeps_good_values(self):
        self._store({"theme.font": "Exo 2", "theme.color_media_tv": "#00FF00"})
        data = self.client.get("/api/branding").json()
        self.assertEqual(data["font"], "Exo 2")
        self.assertEqual(data["colors"]["media_tv"], "#00FF00")


if __name__ == "__main__":
    unittest.main()
