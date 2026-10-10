"""
The frosted glass's strengths are settings, beside its blur: theme.frost_tint,
frost_highlight, frost_sheen, frost_grain, frost_depth and frost_saturation
(whole numbers; tint, sheen and grain in hundredths, the rest in percent).
Their defaults are the glass slab (D8) the owner chose: tint 25, highlight,
depth and saturation 100, no sheen and no grain. The blur's range is 0 to 64.

They reach the page through the theme engine's one chain, as the blur does:
the registry (validated, so an out-of-range save is a 422), the branding
payload (held inside the bounds), the page's #ws-theme (a --ws-frost-*
number, so the first paint is right with no script), theme-loader.js (after a
Settings save, with the same bounds) and theme.css's zero-specificity
defaults. theme.css's one recipe multiplies the slab's own values by them in
calc(), so nothing in script builds a shadow. They are plain numbers, so the
settings export carries them and an import applies them.

Run inside the container:
    python -m unittest discover -s /app/app/tests -t /app -v
"""
import re
import unittest
from unittest import mock

from app.tests.test_shell_contract import STATIC, live_matches

THEME = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
LOADER = (STATIC / "js" / "theme-loader.js").read_text(encoding="utf-8")

try:
    from app import pages, seed
    from app.routers.branding import DEFAULTS as BRANDING_DEFAULTS
    from app.settings_registry import FROST_STRENGTHS, REGISTRY, validate_value
    from app.tests import helpers
    from app.tests.test_theme_engine import payload
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

# key: (default, max, custom property, the property's value at the default)
SLAB = {
    "frost_tint": ("25", 60, "--ws-frost-tint-a", ".25"),
    "frost_highlight": ("100", 200, "--ws-frost-hl", "1"),
    "frost_sheen": ("0", 30, "--ws-frost-sheen", "0"),
    "frost_grain": ("0", 15, "--ws-frost-grain", "0"),
    "frost_depth": ("100", 200, "--ws-frost-depth", "1"),
    "frost_saturation": ("100", 200, "--ws-frost-sat", "1"),
}


def where_root() -> str:
    m = re.search(r":where\(:root\) \{(.*?)\n\}", THEME, flags=re.S)
    assert m
    return m.group(1)


class TheStylesheet(unittest.TestCase):
    def test_the_defaults_are_the_slab_with_no_specificity(self):
        root = where_root()
        self.assertIn("--ws-frost-blur: blur(15px);", root)
        for key, (_, _, var, value) in SLAB.items():
            self.assertIn(f"{var}: {value};", root, key)

    def test_the_recipe_reads_them_in_calc(self):
        css = re.sub(r"/\*.*?\*/", "", THEME, flags=re.S)
        for var in ("--ws-frost-tint-a", "--ws-frost-hl", "--ws-frost-sheen", "--ws-frost-grain",
                    "--ws-frost-depth", "--ws-frost-sat"):
            self.assertIn(f"var({var})", css, var)
        self.assertIn("--ws-frost-boost: saturate(calc(1 + .5 * var(--ws-frost-sat))) "
                      "brightness(calc(1 + .06 * var(--ws-frost-sat)));", css)
        self.assertIn("--ws-frost-sheen-layer: linear-gradient(160deg, rgb(255 255 255 / var(--ws-frost-sheen)), "
                      "rgb(255 255 255 / 0) 45%);", css)
        # Grain is a background layer too: the noise tile cross-faded toward an
        # empty one by the setting, only where cross-fade exists.
        self.assertRegex(css, r"@supports \(background-image: -webkit-cross-fade\([^)]*\)[^)]*\)[^)]*\)\) \{\s*:root \{\s*"
                              r"--ws-frost-grain-layer: -webkit-cross-fade\(var\(--ws-frost-noise\), "
                              r"var\(--ws-frost-noise-none\), calc\(\(1 - var\(--ws-frost-grain\)\) \* 100%\)\) "
                              r"0 0 / 160px 160px;")
        self.assertIn("--ws-frost-fill: var(--ws-frost-sheen-layer), var(--ws-frost-grain-layer), "
                      "linear-gradient(var(--ws-frost-tint), var(--ws-frost-tint));", css)

    def test_no_script_builds_a_shadow(self):
        # The page's scripts set only the numbers; the shadows are theme.css's.
        for rel in ("js/theme-loader.js", "js/settings/appearance.js"):
            src = (STATIC / rel).read_text(encoding="utf-8")
            self.assertFalse(live_matches(src, r"--ws-frost-shadow"), rel)
            self.assertFalse(live_matches(src, r"box-shadow|boxShadow"), rel)


class TheLoader(unittest.TestCase):
    def test_it_applies_each_number_inside_the_registry_bounds(self):
        rows = re.findall(r"\['(frost_\w+)', '(--ws-frost-[\w-]+)', (\d+)\]", LOADER)
        self.assertEqual({k: (v, int(hi)) for k, v, hi in rows},
                         {k: (s[2], s[1]) for k, s in SLAB.items()})
        self.assertTrue(live_matches(
            LOADER, r"if \(typeof v === 'number' && v % 1 === 0 && v >= 0 && v <= f\[2\]\) \{"))
        self.assertTrue(live_matches(LOADER, r"root\.style\.setProperty\(f\[1\], String\(v / 100\)\);"))
        self.assertTrue(live_matches(
            LOADER, r"if \(typeof blur === 'number' && blur % 1 === 0 && blur >= 0 && blur <= 64\) \{"))


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class TheSettings(unittest.TestCase):
    def test_registry_rows(self):
        self.assertEqual(set(FROST_STRENGTHS), set(SLAB))
        for key, (default, hi, _, _) in SLAB.items():
            d = REGISTRY["theme." + key]
            self.assertEqual((d.type, d.default, d.min, d.max, d.public, d.secret, d.allow_empty),
                             ("int", default, 0, hi, True, False, False), key)
            self.assertEqual(seed.DEFAULT_SETTINGS["theme." + key][0], default, key)
            self.assertEqual(BRANDING_DEFAULTS["theme." + key], default, key)
            for ok in ("0", default, str(hi)):
                self.assertIsNone(validate_value("theme." + key, ok), (key, ok))
            for bad in ("-1", str(hi + 1), ".25", "0.25", "25%", "", "lots"):
                self.assertIsNotNone(validate_value("theme." + key, bad), (key, bad))
        blur = REGISTRY["theme.frost_blur"]
        self.assertEqual((blur.default, blur.min, blur.max), ("15", 0, 64))

    def test_the_payload_holds_them_in_bounds(self):
        p = payload()
        for key, (default, hi, _, _) in SLAB.items():
            self.assertEqual(p[key], int(default), key)
            self.assertEqual(payload({"theme." + key: str(hi + 50)})[key], hi, key)
            self.assertEqual(payload({"theme." + key: "-5"})[key], 0, key)
            for junk in ("", "4px", "1.5", "x;}"):
                self.assertEqual(payload({"theme." + key: junk})[key], int(default), (key, junk))
        self.assertEqual(payload({"theme.frost_blur": "99"})["frost_blur"], 64)

    def test_ws_theme_writes_each_as_a_number(self):
        def ws_theme(values=None):
            style = pages.theme_style(payload(values))
            return dict(re.findall(r"(--[\w-]+):([^;}]+)", style))
        decl = ws_theme()
        for key, (_, _, var, value) in SLAB.items():
            self.assertEqual(float(decl[var]), float(value), key)
        decl = ws_theme({"theme.frost_tint": "7", "theme.frost_depth": "150", "theme.frost_grain": "15"})
        self.assertEqual(decl["--ws-frost-tint-a"], "0.07")
        self.assertEqual(decl["--ws-frost-depth"], "1.5")
        self.assertEqual(decl["--ws-frost-grain"], "0.15")
        # A hand-edited payload never writes anything but a number.
        style = pages.theme_style(dict(payload(), frost_sheen="1;}body{x", frost_highlight=True))
        self.assertIn("--ws-frost-sheen:0;", style)
        self.assertIn("--ws-frost-hl:1;", style)

    def test_first_paint_is_the_slab_with_no_script(self):
        # Default settings render exactly the stylesheet's defaults, so a page
        # whose scripts never ran paints the same glass.
        root = where_root()
        style = pages.theme_style(payload())
        for key, (_, _, var, value) in SLAB.items():
            m = re.search(re.escape(var) + r":([^;}]+)", style)
            self.assertEqual(float(m.group(1)), float(re.search(re.escape(var) + r": ([^;]+);", root).group(1)), key)
        self.assertIn("--ws-frost-blur:blur(15px)", style)


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class TheApi(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        self.client = helpers.api_client(self.Session, headers=helpers.SAME_ORIGIN)

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()
        self.db.close()

    def save(self, *pairs):
        return self.client.put("/api/admin/settings/bulk",
                               json={"settings": [{"key": k, "value": v} for k, v in pairs]})

    def test_a_save_in_range_is_stored(self):
        r = self.save(("theme.frost_tint", "40"), ("theme.frost_depth", "150"), ("theme.frost_blur", "64"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(helpers.get(self.db, "theme.frost_tint"), "40")
        self.assertEqual(helpers.get(self.db, "theme.frost_blur"), "64")

    def test_out_of_range_is_a_422_and_nothing_is_stored(self):
        for key, (_, hi, _, _) in SLAB.items():
            for bad in (str(hi + 1), "-1", "0.5", "abc"):
                r = self.save(("theme." + key, bad))
                self.assertEqual(r.status_code, 422, (key, bad, r.text))
                self.assertIn("theme." + key, r.json()["errors"])
        r = self.save(("theme.frost_blur", "65"))
        self.assertEqual(r.status_code, 422, r.text)
        for key in SLAB:
            self.assertIsNone(helpers.get(self.db, "theme." + key), key)

    def test_export_and_import_carry_them(self):
        helpers.put(self.db, "theme.frost_grain", "6")
        r = self.client.get("/api/admin/settings/export")
        self.assertEqual(r.status_code, 200, r.text)
        exported = r.json()["settings"]
        for key, (default, _, _, _) in SLAB.items():
            self.assertIn("theme." + key, exported)
        self.assertEqual(exported["theme.frost_grain"], "6")
        self.assertEqual(exported["theme.frost_tint"], "25")
        data = r.json()
        data["settings"] = dict(exported, **{"theme.frost_grain": "0", "theme.frost_sheen": "12"})
        r = self.client.post("/api/admin/settings/import?dry_run=true", json={"data": data})
        self.assertEqual(r.status_code, 200, r.text)
        changed = {c["key"]: c["new"] for c in r.json()["changes"]}
        self.assertEqual(changed, {"theme.frost_grain": "0", "theme.frost_sheen": "12"})
        r = self.client.post("/api/admin/settings/import?dry_run=false",
                             json={"data": data, "diff_token": r.json()["diff_token"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(helpers.get(self.db, "theme.frost_sheen"), "12")
        data["settings"]["theme.frost_sheen"] = "31"
        r = self.client.post("/api/admin/settings/import?dry_run=true", json={"data": data})
        self.assertEqual(r.status_code, 422, r.text)


if __name__ == "__main__":
    unittest.main()
