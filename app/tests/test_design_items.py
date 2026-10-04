"""
The AI-giveaways audit's design items (2026-10-04; v2 step 5, Task 3), kept.

H3   no row of identical count cards: counts are one quiet line.
M3   Issues, Tickets, News and the Wiki share the Books card and type.
M7   the login card: the Books language, Plex in plain words, one status line,
     and its anti-flash reveal exactly as it was (Review Focus 5).
M8   Requests is grouped by what people want, not by which service answers.
L4   the media, status and gauge colours are derived from the brand palette.
L8   the shipped font is this site's own file, preloaded, with a
     metric-matched fallback.

The runtime half (the pages run in happy-dom) is app/tests/js/design_pages.mjs.
"""
import math
import re
import unittest
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "static"

try:
    from app.settings_registry import REGISTRY
    HAVE_REGISTRY = True
except Exception:  # pragma: no cover
    HAVE_REGISTRY = False

try:
    from app.tests import helpers
    from app import seed, pages
    from app.models import Setting
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False


def read(rel: str) -> str:
    return (STATIC / rel).read_text(encoding="utf-8")


# ---- colour maths (WCAG 2 and OKLCH) ----

def _lin(c: float) -> float:
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _rgb(hexv: str):
    h = hexv.lstrip("#")
    return [int(h[i:i + 2], 16) for i in (0, 2, 4)]


def luminance(hexv: str) -> float:
    r, g, b = (_lin(x) for x in _rgb(hexv))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    x, y = sorted((luminance(a), luminance(b)), reverse=True)
    return (x + 0.05) / (y + 0.05)


def oklch(hexv: str):
    r, g, b = (_lin(x) for x in _rgb(hexv))
    l_ = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m_ = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s_ = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    A = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return L, math.hypot(A, B), math.degrees(math.atan2(B, A)) % 360


FAMILIES = {
    "media": ("media_movie", "media_tv", "media_book"),
    "status": ("status_ok", "status_warn", "status_err"),
    "gauge": ("gauge_cpu", "gauge_ram", "gauge_net"),
}
# The stock values these replaced (Tailwind's purple, cyan, amber, green, red).
STOCK = {"#E9D5FF", "#67E8F9", "#FCD34D", "#4ADE80", "#FBBF24", "#F87171", "#06B6D4", "#A855F7", "#F97316"}


@unittest.skipUnless(HAVE_REGISTRY, "needs the settings registry")
class SecondaryPaletteFromTheBrand(unittest.TestCase):
    """L4: each family holds one OKLCH lightness and chroma (so words on it
    keep their contrast whatever the hue), with hues spread around the
    brand's, and clears its contrast where it is used."""

    def default(self, key):
        return REGISTRY["theme.color_" + key].default.upper()

    def test_no_stock_kit_colour_is_a_default(self):
        for keys in FAMILIES.values():
            for k in keys:
                self.assertNotIn(self.default(k), STOCK, k)

    def test_each_family_holds_one_lightness_and_chroma(self):
        for fam, keys in FAMILIES.items():
            lch = [oklch(self.default(k)) for k in keys]
            with self.subTest(fam):
                self.assertLess(max(x[0] for x in lch) - min(x[0] for x in lch), 0.012, lch)
                self.assertLess(max(x[1] for x in lch) - min(x[1] for x in lch), 0.012, lch)
                hues = sorted(x[2] for x in lch)
                gaps = [b - a for a, b in zip(hues, hues[1:])] + [360 - hues[-1] + hues[0]]
                self.assertGreater(min(gaps), 40, hues)       # three distinct hues (red and amber sit closest)

    def test_chroma_stays_in_the_brands_restraint(self):
        brand = oklch(REGISTRY["theme.color_primary"].default)
        for keys in FAMILIES.values():
            for k in keys:
                self.assertLessEqual(oklch(self.default(k))[1], brand[1] + 0.02, k)

    def test_contrast_where_each_is_used(self):
        primary = REGISTRY["theme.color_primary"].default
        background = REGISTRY["theme.color_background"].default
        text = REGISTRY["theme.color_text"].default
        for k in FAMILIES["media"]:       # words on the primary fill and on the page
            self.assertGreaterEqual(contrast(self.default(k), primary), 4.5, k)
            self.assertGreaterEqual(contrast(self.default(k), background), 4.5, k)
        for k in FAMILIES["status"] + FAMILIES["gauge"]:   # dots, rings and arcs on the page
            self.assertGreaterEqual(contrast(self.default(k), background), 3.0, k)
        for k in FAMILIES["status"]:      # status words: 40% status in the text colour
            mixed = "#" + "".join("%02X" % round(a * 0.4 + b * 0.6) for a, b in zip(_rgb(self.default(k)), _rgb(text)))
            self.assertGreaterEqual(contrast(mixed, background), 4.5, k)

    def test_theme_css_carries_the_same_defaults(self):
        theme = read("css/theme.css")
        for keys in FAMILIES.values():
            for k in keys:
                var = k.replace("_", "-")
                self.assertIn(f"--hex-{var}: {self.default(k)};", theme, k)
                trip = " ".join(str(x) for x in _rgb(self.default(k)))
                self.assertIn(f"--color-{var}: {trip};", theme, k)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SecondaryPaletteMigration(unittest.TestCase):
    """An install still on the stock defaults moves to the derived ones once;
    a colour an operator picked stays."""

    def setUp(self):
        self.db = helpers.make_sessionmaker()()

    def tearDown(self):
        self.db.close()

    def put(self, key, value):
        self.db.add(Setting(key=key, value=value, description="x"))
        self.db.commit()

    def get(self, key):
        row = self.db.query(Setting).filter(Setting.key == key).first()
        return row.value if row else None

    def test_stock_values_move_and_chosen_ones_stay(self):
        self.put("theme.color_media_movie", "#E9D5FF")
        self.put("theme.color_status_ok", "#4ade80")          # any case
        self.put("theme.color_status_err", "#123456")         # the operator's own
        seed.migrate_secondary_palette_v1(self.db)
        self.assertEqual(self.get("theme.color_media_movie"), REGISTRY["theme.color_media_movie"].default)
        self.assertEqual(self.get("theme.color_status_ok"), REGISTRY["theme.color_status_ok"].default)
        self.assertEqual(self.get("theme.color_status_err"), "#123456")
        self.assertEqual(self.get("migration.secondary_palette_v1"), "done")

    def test_it_runs_once(self):
        seed.migrate_secondary_palette_v1(self.db)
        row = self.db.query(Setting).filter(Setting.key == "theme.color_gauge_ram").first()
        if row is None:
            self.put("theme.color_gauge_ram", "#A855F7")
        else:
            row.value = "#A855F7"
            self.db.commit()
        seed.migrate_secondary_palette_v1(self.db)   # the marker holds: a stock value put back stays
        self.assertEqual(self.get("theme.color_gauge_ram"), "#A855F7")

    def test_every_pair_is_a_registry_default(self):
        for key, old, new in seed.SECONDARY_PALETTE_V1:
            self.assertEqual(REGISTRY[key].default, new, key)
            self.assertIn(old, STOCK, key)

    def test_it_runs_at_start_after_seeding(self):
        src = (Path(seed.__file__).parent / "database.py").read_text(encoding="utf-8")
        self.assertLess(src.index("        seed_default_settings(db)"), src.index("        migrate_secondary_palette_v1(db)"))


class BundledFont(unittest.TestCase):
    """L8: the shipped font is served from here and preloaded; until it lands
    (font-display: optional) the page keeps a fallback with its metrics."""

    def test_the_files(self):
        fonts = STATIC / "fonts"
        for f in ("spline-sans-latin.woff2", "spline-sans-latin-ext.woff2", "OFL.txt", "spline-sans.css"):
            self.assertTrue((fonts / f).exists(), f)
        self.assertEqual((fonts / "spline-sans-latin.woff2").read_bytes()[:4], b"wOF2")
        self.assertIn("SIL Open Font License", (fonts / "OFL.txt").read_text(encoding="utf-8"))
        css = (fonts / "spline-sans.css").read_text(encoding="utf-8")
        self.assertEqual(css.count("font-display: optional;"), 2)
        self.assertNotIn("font-display: swap", css)
        self.assertIn('url("/static/fonts/spline-sans-latin.woff2")', css)   # the preloaded address, exactly

    def test_the_fallback_face(self):
        theme = read("css/theme.css")
        face = theme[theme.index('font-family: "Spline Sans Fallback";') - 20:]
        face = face[:face.index("}")]
        for decl in ('local("Arial")', "size-adjust: 101.44%;", "ascent-override: 94.98%;",
                     "descent-override: 23.31%;", "line-gap-override: 0%;"):
            self.assertIn(decl, face)
        self.assertIn('--font-display: "Spline Sans", "Spline Sans Fallback", sans-serif;', theme)

    @unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
    def test_the_head(self):
        links = pages.font_links({"font": "Spline Sans"})
        self.assertTrue(links.startswith('<link rel="preload" href="/static/fonts/spline-sans-latin.woff2" as="font" type="font/woff2" crossorigin>'))
        self.assertNotIn("googleapis", links)
        self.assertEqual(pages.font_stack({"font": "Spline Sans"}), '"Spline Sans","Spline Sans Fallback",sans-serif')
        self.assertEqual(pages.font_stack({"font": "Exo 2"}), '"Exo 2",sans-serif')
        other = pages.font_links({"font": "Exo 2"})
        self.assertIn("fonts.googleapis.com/css2?family=Exo+2", other)
        self.assertNotIn("preload", other)


class CountsAreOneQuietLine(unittest.TestCase):
    """H3: Issues, Tickets and Requests lead with what a person came for;
    counts are one quiet line, held at its height."""

    def test_no_number_cards(self):
        for rel in ("issues.html", "tickets.html", "requests.html"):
            page = read(rel)
            for gone in ('id="statTotal"', 'id="statOpen"', 'id="statsRow"', 'id="statSize"', "grid-cols-3 gap-3 mb-8",
                         "sm:grid-cols-4 gap-3 mb-8"):
                self.assertNotIn(gone, page, f"{rel}: {gone}")

    def test_the_lines(self):
        line = 'class="mt-1 mb-4 text-label leading-5 min-h-5 text-frosted-blue/70 tabular-nums" data-arrive="counts"'
        self.assertIn('<p id="issuesCounts" ' + line, read("issues.html"))
        self.assertIn('<p id="ticketsCounts" ' + line, read("tickets.html"))
        self.assertIn("$('issuesCounts').textContent = countsLine(counts);", read("js/pages/issues.js"))
        self.assertIn("$('ticketsCounts').textContent = countsLine(data);", read("js/pages/tickets.js"))
        self.assertIn('<p id="requestWait" class="mt-2 text-label leading-5 min-h-10 sm:min-h-5 text-frosted-blue/70">', read("requests.html"))

    def test_tickets_lead_with_the_action(self):
        page = read("tickets.html")
        self.assertLess(page.index('data-action="open-create"'), page.index('id="ticketsTitle"'))
        self.assertLess(page.index('id="ticketsTitle"'), page.index('id="ticketList"'))


class RequestsByWhatPeopleWant(unittest.TestCase):
    """M8: one search at the top, results in place of the rest, three shelves."""

    def test_the_order(self):
        page = read("requests.html")
        order = [page.index(m) for m in ('id="searchInput"', 'id="searchResultsSection"', 'id="browseArea"',
                                          'id="trendingRow"', 'id="comingRow"', 'id="booksRow"',
                                          'id="rsSection"', 'id="recentTitle"')]
        self.assertEqual(order, sorted(order))
        self.assertIn('<section id="searchResultsSection" class="hidden mt-8"', page)
        self.assertNotIn('id="searchEmptyState"', page)
        self.assertNotIn('id="searchHome"', page)

    def test_no_travelling_search_bar(self):
        js = read("js/pages/requests.js")
        for gone in ("moveSearchBar", "SEARCH_MOVE_DURATION", "swallowScroll", "scrollPlanFor"):
            self.assertNotIn(gone, js)


class TheBooksCard(unittest.TestCase):
    """M3: the older pages share the Books surface and type."""

    ROW = "rounded-2xl bg-frosted-blue/[0.04] hover:bg-frosted-blue/[0.07]"

    def test_rows(self):
        self.assertIn("w-full text-left " + self.ROW, read("js/pages/issues.js"))
        self.assertIn("block w-full text-left " + self.ROW, read("js/pages/tickets.js"))
        self.assertIn('<article class="rounded-2xl bg-frosted-blue/[0.04] p-4 sm:p-5 min-w-0">', read("js/pages/news.js"))
        wiki = read("js/pages/wiki.js")
        self.assertGreaterEqual(wiki.count("rounded-2xl bg-frosted-blue/[0.04]"), 4)

    def test_the_old_dialect_is_gone(self):
        for rel in ("js/pages/wiki.js", "js/pages/news.js", "news.html"):
            src = read(rel)
            for old in ("bg-baltic-blue", "border-steel-blue", "text-steel-blue", "text-xs", "text-sm"):
                self.assertNotIn(old, src, f"{rel}: {old}")
        # A link in a wiki page reads on the page: not the primary blue (under 3:1 on black).
        self.assertNotIn(".wiki-body a  { color: rgb(var(--color-primary))", read("wiki.html"))

    def test_status_colour_only_on_deviation(self):
        issues = read("js/pages/issues.js")
        self.assertIn("(issue.status === 'open' ? '<span class=\"shrink-0\">' + getIssueStatusBadge('open')", issues)


class LoginCard(unittest.TestCase):
    """M7, and Review Focus 5: the reveal and failsafe are exactly as shipped."""

    def test_review_focus_5(self):
        page = read("login.html")
        head = page.split("</head>")[0]
        for rule in ("#loginForm { visibility: hidden; }",
                     "#loginForm.auth-ready { visibility: visible; }",
                     "html:not([data-login-js]) #loginForm { animation: login-fallback-show 0s linear 2.5s forwards; }",
                     "@keyframes login-fallback-show { to { visibility: visible; } }"):
            self.assertIn(rule, head)
        js = read("js/login.js")
        self.assertIn("var REVEAL_AFTER_MS = 2500;", js)
        self.assertIn("setTimeout(revealForm, REVEAL_AFTER_MS);", js)
        self.assertIn("document.documentElement.setAttribute('data-login-js', '');", js.split("\n\n")[1])
        body = page.split("</head>")[1]
        self.assertLess(body.index('id="loginForm"'), body.index('id="loginLoadHint"'))

    def test_the_card(self):
        page = read("login.html")
        for gone in ("via Authentik", "Arial Black", "uppercase", ">PLEX<", "h-48", "Or continue with"):
            self.assertNotIn(gone, page)
        self.assertEqual(page.count(">Continue with Plex</button>"), 2)
        self.assertIn('<img id="loginLogo" alt="" class="h-16 ', page)
        scrim = page[page.index(".cinematic-overlay {"):]
        scrim = scrim[:scrim.index("}")]
        alphas = [float(a) for a in re.findall(r"/ (0\.\d+)\)", scrim)]
        self.assertTrue(alphas and max(alphas) <= 0.65, alphas)

    def test_the_status_line(self):
        js = read("js/login.js")
        self.assertIn("name ? name + ' is down' : 'Something is down'", js)
        self.assertIn("'All services running'", js)
        self.assertIn("'Status unavailable right now'", js)
        self.assertNotIn("innerHTML", js[js.index("function loadSystemStatus"):js.index("function showLoginError")])


if __name__ == "__main__":
    unittest.main()
