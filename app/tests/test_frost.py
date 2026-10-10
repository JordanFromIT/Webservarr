"""
One frosted surface and one popover motion for everything that floats.

The frost (theme.css .ws-frost and its --ws-frost-* tokens) is the glass
slab the owner chose (D8): the secondary colour mixed 30% toward the text
colour, at 25% (rgb(88 148 186 / .25) with the shipped palette), over the
blur setting (15px by default) with saturate(1.5) brightness(1.06), a 1px
gradient ring drawn in the border's area, a lit rim, an inside thickness
and a layered lift with a faint glow of the tint's colour. The phone tab
bar takes it turned over (a top-edge line, the shadow mirrored upward).
The sign-in card wears the same tokens. Every menu, popover, panel, sheet,
dialog and toast wears it, and none carries a recipe of its own. There is no
floor: nothing dark is laid under the tint, so over very bright art the light
text loses contrast (about 1.1:1 over pure white). The owner made that trade
knowingly; the contrast checks here pin the numbers it gives, for the default
palette, so a change to them is a decision and not an accident.

Every popover opens and closes as the service status panel does (.ws-pop:
220ms in, 140ms out, faded, 6px up and unfolded from its top edge); the
player's drop-down runs the same motion as keyframes; sheets slide on the
same timing. Reduced motion turns all of it off (the player keeps a fade).

Run inside the container:
    python -m unittest discover -s /app/app/tests -t /app -v
"""
import re
import unittest

from app.tests.test_motion import css_rule, top_level
from app.tests.test_shell_contract import STATIC, js_code_only, live_matches

THEME = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
APP_CSS = (STATIC / "css" / "app.css").read_text(encoding="utf-8")
LOGIN = (STATIC / "login.html").read_text(encoding="utf-8")


def read(rel: str) -> str:
    return (STATIC / rel).read_text(encoding="utf-8")


def token(name: str) -> str:
    """A token's value at :root (two-space indent), whitespace collapsed."""
    m = re.search(r"\n  " + re.escape(name) + r":\s*([^;]+);", THEME)
    assert m, name
    return " ".join(m.group(1).split())


def supported(feature: str) -> dict:
    """The :root tokens a browser with `feature` gets (theme.css @supports)."""
    m = re.search(r"@supports \(" + re.escape(feature) + r"\) \{\s*:root \{(.*?)\}\s*\}", THEME, flags=re.S)
    assert m, feature
    return {k: " ".join(v.split()) for k, v in re.findall(r"(--[\w-]+):\s*([^;]+);", m.group(1))}


def default_rgb(name: str) -> tuple:
    """A palette colour's shipped default (theme.css :where(:root))."""
    m = re.search(r"--color-" + re.escape(name) + r": (\d+) (\d+) (\d+);", THEME)
    assert m, name
    return tuple(int(x) for x in m.groups())


def alpha_of(expr: str) -> float:
    m = re.search(r"/ \.?([\d.]+)\)", expr)
    assert m, expr
    v = m.group(1)
    return float(v if "." in v or v in ("0", "1") else "." + v)


def lum(rgb) -> float:
    def ch(c):
        c = c / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b) -> float:
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def over(top, alpha, under):
    return tuple(t * alpha + u * (1 - alpha) for t, u in zip(top, under))


WHITE = (255, 255, 255)


def icy(text=None) -> tuple:
    """The tint's colour: the secondary mixed 30% toward the text colour."""
    return over(text or default_rgb("text"), 0.3, default_rgb("secondary"))


def frosted(behind, floor=0.0):
    """What the frost paints over `behind`: the floor, then the tint."""
    tint = alpha_of(token("--ws-frost-tint"))
    return over(icy(), tint, over(default_rgb("background"), floor, behind))


def supported_tint() -> str:
    """The tint a browser with color-mix() gets (theme.css @supports)."""
    return supported("color: color-mix(in srgb, red, blue)")["--ws-frost-tint"]


BACKDROP = "backdrop-filter: var(--ws-frost-blur) var(--ws-frost-boost);"
SLAB_BG = ("background: var(--ws-frost-ring-layer), linear-gradient(var(--ws-frost-tint), var(--ws-frost-tint)), "
           "rgb(var(--color-background) / var(--ws-frost-floor));")


# Every surface that floats over the page, and the text that shows its class.
FROSTED = {
    "status popover": ("js/status-panel.js", r"el\('div', '([^']*ws-sp-pop[^']*)'\)"),
    "status sheet": ("js/status-panel.js", r"sheetPanel = el\('div', '([^']*)'\)"),
    "bell panel": ("js/notifications.js", r"_dropdown = createEl\('div',\s*'([^']*)'"),
    "notification settings": ("js/notifications.js", r"var card = createEl\('div', '([^']*)'\)"),
    "account menu": ("partials/shell-header.html", r'id="userMenuDropdown" class="([^"]*)"'),
    "More sheet": ("partials/shell-sidebar.html", r'<div class="([^"]*ws-sheet-panel[^"]*)" data-sheet-panel>'),
    "Continue menu": ("js/pages/books.js", r"const menu = el\('div', '([^']*)'\)"),
    "Books picker (wide)": ("js/pages/books.js", r"panel = el\('div', '([^']*w-80[^']*)'\)"),
    "Books sort (wide)": ("js/pages/books.js", r"panel = el\('div', '([^']*w-56[^']*)'\)"),
    "Books sheets": ("js/pages/books.js", r"panel = el\('div', '(ws-sheet-panel[^']*)'\)"),
    "dialog (WSUI.confirm)": ("js/ui.js", r"var box = el\('div', '([^']*)'\)"),
    "toast": ("js/ui.js", r"var t = el\('div', ('[^;]*)\);"),
    "issue detail": ("issues.html", r'<div data-dialog-box aria-labelledby="issueDetailTitle" class="([^"]*)"'),
    "new ticket": ("tickets.html", r'<form id="createForm" data-dialog-box [^>]*class="([^"]*)"'),
    "ticket detail": ("tickets.html", r'<div data-dialog-box aria-labelledby="ticketDetailTitle" class="([^"]*)"'),
    "media detail": ("requests.html", r'<div data-dialog-box aria-labelledby="modalTitle" class="([^"]*)"'),
    "book pop-up": ("partials/book-dialog.html", r'<div data-dialog-box role="dialog" [^>]*class="([^"]*)"'),
    "Requests search bar": ("requests.html", r'id="searchInput"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*id="searchInput"'),
    "calendar day panel": ("calendar.html", r'<section id="dayDetailPanel" [^>]*class="([^"]*)"'),
    "reader settings": ("reader.html", r'<div id="settingsPanel" [^>]*class="([^"]*)"'),
    "reader contents": ("reader.html", r'<aside id="tocPanel" class="([^"]*)"'),
    "Settings save bar": ("js/settings/kit.js", r"bar\.className = ('[^;]*);"),
}

# A popover: opens and closes through .ws-pop (the status panel's motion).
POPOVERS = ["status popover", "bell panel", "account menu", "Continue menu",
            "Books picker (wide)", "Books sort (wide)", "calendar day panel", "reader settings"]


def surface_classes(name: str) -> list:
    rel, pattern = FROSTED[name]
    src = read(rel)
    found = re.findall(pattern, src, flags=re.S)
    assert found, f"{name}: not found in {rel}"
    out = []
    for f in found:
        text = "".join(f) if isinstance(f, tuple) else f
        out.append(re.sub(r"'\s*\+\s*'", "", text).strip("'").split())
    return out


class OneFrost(unittest.TestCase):
    def test_the_tokens_are_the_icy_glass(self):
        # The card wears the tokens themselves, so its blur follows the setting.
        card = re.search(r"\.login-glass-card \{([^}]*)\}", LOGIN).group(1)
        self.assertIn("background: var(--ws-frost-ring-layer), linear-gradient(var(--ws-frost-tint), var(--ws-frost-tint));", card)
        # The icy tint: the secondary mixed 30% toward the text colour, at 25%,
        # from the palette's own tokens; without color-mix() the secondary at 25%.
        self.assertEqual(supported_tint(), "color-mix(in srgb, rgb(var(--color-secondary) / .25) 70%, "
                                           "rgb(var(--color-text) / .25))")
        self.assertEqual(token("--ws-frost-tint"), "rgb(var(--color-secondary) / .25)")
        self.assertEqual(tuple(round(c) for c in icy()), (88, 148, 186))
        self.assertIn("-webkit-" + BACKDROP, card)
        self.assertIn("\n      " + BACKDROP, card)
        self.assertEqual(token("--ws-frost-blur"), "blur(15px)")
        self.assertIn("border: 1px solid var(--ws-frost-edge);", card)
        self.assertEqual(token("--ws-frost-edge"), "rgb(var(--color-text) / .12)")
        self.assertNotRegex(card, r"blur\(\d")
        # The card's shadow is the frost's own (the slab's), not a class.
        self.assertIn("box-shadow: var(--ws-frost-shadow);", card)
        self.assertNotRegex(LOGIN, r'class="[^"]*\blogin-glass-card\b[^"]*\bshadow-')
        # No floor, on a scrim or off it.
        self.assertEqual(token("--ws-frost-floor"), "0")
        self.assertEqual(token("--ws-frost-floor-on-scrim"), "0")

    def test_the_class_paints_only_the_tokens(self):
        rule = re.search(r"\n\.ws-frost \{([^}]*)\}", THEME).group(1)
        self.assertIn(SLAB_BG, rule)
        self.assertIn("-webkit-" + BACKDROP, rule)
        self.assertIn("\n  " + BACKDROP, rule)
        self.assertIn("border-color: var(--ws-frost-edge);", rule)
        self.assertIn("box-shadow: var(--ws-frost-shadow);", rule)
        # On a scrim (a sheet, a dialog) the floor is the scrim's top-up.
        self.assertIn("--ws-frost-floor: var(--ws-frost-floor-on-scrim);",
                      css_rule(THEME, ":is(.ws-sheet-panel, .ws-dialog-box, [data-dialog-box]).ws-frost"))

    def test_no_second_recipe(self):
        # The old reading-floor variant is gone, from the stylesheet and from every surface.
        for path in list(STATIC.rglob("*.js")) + list(STATIC.rglob("*.html")) + [STATIC / "css" / "theme.css"]:
            self.assertNotIn("ws-frost-read", path.read_text(encoding="utf-8"), path.name)

    def test_every_floating_surface_wears_it(self):
        for name in FROSTED:
            for classes in surface_classes(name):
                self.assertIn("ws-frost", classes, f"{name}: {' '.join(classes)}")
                # No surface paints a colour, blur or shadow of its own over the frost.
                own = [c for c in classes if re.match(r"(?:lg:)?(?:bg-|backdrop-|shadow-)", c)]
                self.assertEqual(own, [], name)

    def test_the_player_notices_paint_the_tokens(self):
        # The player's notices stack above its bar like toasts: the same frost.
        rule = css_rule(THEME, ".wsp-notice")
        self.assertIn(SLAB_BG, rule)
        self.assertIn(BACKDROP, rule)
        self.assertIn("border: 1px solid var(--ws-frost-edge);", rule)
        self.assertIn("box-shadow: var(--ws-frost-shadow);", rule)

    def test_the_player_drop_down_paints_the_tokens(self):
        rule = css_rule(THEME, ".wsp-full.is-window")
        self.assertIn(SLAB_BG, rule)
        self.assertIn(BACKDROP, rule)
        self.assertIn("border: 1px solid var(--ws-frost-edge);", rule)
        self.assertIn("box-shadow: var(--ws-frost-shadow);", rule)
        # Its pointer is the same frost, cut to the half above the window's edge.
        caret = css_rule(THEME, ".wsp-full.is-window:not(.is-pip) .wsp-drop-caret")
        self.assertIn("clip-path: polygon(0 0, 100% 0, 0 100%);", caret)
        self.assertIn("var(--ws-frost-floor)", caret)
        self.assertIn("background: var(--ws-frost-ring-layer), ", caret)


class TheGlassSlab(unittest.TestCase):
    """D8, the glass slab, at tint .25 and blur 15 with every strength at 100%:
    the mockup's recipe() output, layer by layer."""

    def test_backdrop_boost(self):
        self.assertEqual(token("--ws-frost-boost"), "saturate(1.5) brightness(1.06)")

    def test_the_ring_is_a_gradient_border_from_the_top_left(self):
        self.assertEqual(token("--ws-frost-ring"),
                         "linear-gradient(135deg, rgb(255 255 255 / .55), rgb(var(--color-text) / .165) 40%, "
                         "rgb(var(--color-text) / .04) 75%)")
        # Drawn in the border's own area: it follows every corner, stays put
        # while a panel scrolls, and needs no pseudo-element (so an <input>,
        # the Requests search field, takes it too).
        sup = supported("background-clip: border-area")
        self.assertEqual(sup["--ws-frost-ring-layer"], "var(--ws-frost-ring) border-box border-area")
        self.assertEqual(sup["--ws-frost-ring-bar-layer"], "var(--ws-frost-ring-bar) border-box border-area")
        # Where it draws, the flat edge gives way to it; elsewhere the layer is
        # "none" and the flat edge (text at 12%) stays.
        self.assertEqual(sup["--ws-frost-edge"], "transparent")
        self.assertEqual(token("--ws-frost-ring-layer"), "none")
        self.assertEqual(token("--ws-frost-ring-bar-layer"), "none")

    def test_the_shadow_is_rim_thickness_lift_and_glow(self):
        self.assertEqual(token("--ws-frost-shadow"), ", ".join([
            "inset 0 1px 0 rgb(255 255 255 / .38)", "inset 1px 0 0 rgb(255 255 255 / .14)",
            "inset 0 -1px 0 rgb(0 0 0 / .256)", "inset 0 -12px 24px -12px rgb(0 0 0 / .32)",
            "inset 0 0 24px rgb(var(--color-text) / .07)",
            "0 1px 2px rgb(0 0 0 / .4)", "0 6px 16px -4px rgb(0 0 0 / .32)", "0 24px 56px -16px rgb(0 0 0 / .5)",
            "0 0 40px -8px var(--ws-frost-glow)"]))
        # The glow is the tint's own colour (the same mix) at .14.
        self.assertEqual(token("--ws-frost-glow"), "rgb(var(--color-secondary) / .14)")
        self.assertEqual(supported("color: color-mix(in srgb, red, blue)")["--ws-frost-glow"],
                         "color-mix(in srgb, rgb(var(--color-secondary) / .14) 70%, rgb(var(--color-text) / .14))")

    def test_the_docked_bar_takes_it_turned_over(self):
        self.assertEqual(token("--ws-frost-ring-bar"),
                         "linear-gradient(90deg, rgb(255 255 255 / .44), rgb(var(--color-text) / .138) 50%, "
                         "rgb(var(--color-text) / .04))")
        self.assertEqual(token("--ws-frost-shadow-up"), ", ".join([
            "inset 0 1px 0 rgb(255 255 255 / .38)", "inset 0 0 24px rgb(var(--color-text) / .07)",
            "0 -1px 2px rgb(0 0 0 / .4)", "0 -6px 16px -4px rgb(0 0 0 / .32)", "0 -24px 56px -16px rgb(0 0 0 / .5)",
            "0 0 40px -8px var(--ws-frost-glow)"]))
        bar = re.search(r"\n\.ws-tabbar \{([^}]*)\}", THEME).group(1)
        self.assertIn("background: var(--ws-frost-ring-bar-layer), linear-gradient(var(--ws-frost-tint), var(--ws-frost-tint)), ", bar)
        self.assertIn("border-top: 1px solid var(--ws-frost-edge);", bar)
        self.assertIn("box-shadow: var(--ws-frost-shadow-up);", bar)

    def test_no_sheen_grain_light_or_refraction(self):
        css = re.sub(r"/\*.*?\*/", "", THEME, flags=re.S)
        for gone in ("--ws-frost-sheen", "--ws-frost-grain", "--ws-frost-light", "feTurbulence", "feDisplacementMap"):
            self.assertNotIn(gone, css)
        # No pseudo-element draws any of it, so none can clash with a
        # surface's own ::before or ::after.
        self.assertFalse(re.search(r"\.ws-frost[^{,]*::(?:before|after)", css))

    def test_the_search_field_wears_the_ring(self):
        # The ring is a background layer clipped to the border's area, so the
        # field needs its 1px border, and keeps the focus ring (the --ws-focus
        # colour) over the slab's shadow.
        for classes in surface_classes("Requests search bar"):
            self.assertIn("ws-frost", classes)
            self.assertIn("border", classes)
            self.assertIn("focus:ring-focus", classes)
        self.assertIn("--tw-shadow: var(--ws-frost-shadow);", re.search(r"\n\.ws-frost \{([^}]*)\}", THEME).group(1))


class FrostContrast(unittest.TestCase):
    """What the floorless icy glass gives the default palette's text.

    The old recipe's floor held 70% text at 4.5:1 over a white poster. The icy
    glass has no floor, by the owner's choice, so these pin the new numbers
    instead: readable over the page colour and dark art, not over bright art."""

    DARK_POSTER = (30, 30, 40)

    def test_over_the_page_colour_and_dark_art_70_percent_text_keeps_4_5_to_1(self):
        for behind in (default_rgb("background"), self.DARK_POSTER):
            bg = frosted(behind)
            for a in (1.0, 0.85, 0.8, 0.7):
                text = over(default_rgb("text"), a, bg)
                self.assertGreaterEqual(ratio(text, bg), 4.5, f"text/{a} over {behind}: {ratio(text, bg):.2f}")

    def test_over_white_the_text_gives_up_its_contrast(self):
        # The trade: nothing dark under the tint, so pure white behind leaves
        # the light text at about 1.1:1. Pinned so a change is noticed.
        bg = frosted(WHITE)
        self.assertLess(ratio(default_rgb("text"), bg), 1.2)
        self.assertGreater(ratio(default_rgb("text"), bg), 1.0)

    def test_there_is_no_floor(self):
        self.assertEqual(float(token("--ws-frost-floor")), 0)
        self.assertEqual(float(token("--ws-frost-floor-on-scrim")), 0)

    def test_on_the_page_colour_a_light_palette_reads_too(self):
        # A light theme (a white page, navy text, the shipped secondary): its
        # icy tint mixes toward the navy, and over its own page colour 70% text
        # keeps about 4.4:1 (full text well over 4.5:1), as the shipped dark
        # palette keeps 4.5:1 at 70%.
        tint = alpha_of(token("--ws-frost-tint"))
        for page, text, floor in (((255, 255, 255), (15, 40, 70), 4.4),
                                  (default_rgb("background"), default_rgb("text"), 4.5)):
            bg = over(icy(text), tint, page)
            self.assertGreaterEqual(ratio(over(text, 0.7, bg), bg), floor, (page, text))
            self.assertGreaterEqual(ratio(text, bg), 4.5, (page, text))

    def test_on_a_scrim_only_the_scrim_dims(self):
        # A sheet or a dialog keeps its scrim (the page colour at .7) and adds
        # no floor: over white, full text keeps 4.5:1 and 70% text about 3.4:1.
        for rule in (css_rule(THEME, ".ws-scrim"), re.search(r"\n\.ws-sheet-scrim \{([^}]*)\}", THEME).group(1)):
            scrim = float(re.search(r"background(?:-color)?: rgb\(var\(--color-background\) / (\.?\d+)\)", rule).group(1))
            on = float(token("--ws-frost-floor-on-scrim"))
            bg = frosted(over(default_rgb("background"), scrim, WHITE), on)
            self.assertGreaterEqual(ratio(default_rgb("text"), bg), 4.5)
            self.assertGreaterEqual(ratio(over(default_rgb("text"), 0.7, bg), bg), 3.3)

    def test_frosted_text_is_never_dimmer_than_70_percent(self):
        # The bell panel and the notification settings were /70 and steel-blue
        # words on a solid panel; on the frost they are /80.
        notif = js_code_only(read("js/notifications.js"), keep_strings=True)
        block = notif[notif.index("function buildDropdown"):notif.index("function applyToggleStyle")]
        self.assertFalse(re.search(r"text-frosted-blue/[1-6]0\b", block), "dim text on the bell panel")
        self.assertNotIn("py-8 text-steel-blue", block)


class OneMotion(unittest.TestCase):
    def test_every_popover_opens_through_ws_pop(self):
        for name in POPOVERS:
            for classes in surface_classes(name):
                self.assertIn("ws-pop", classes, name)
                self.assertNotIn("ws-dialog-box", classes, name)

    def test_popovers_put_in_the_page_open_from_the_closed_state(self):
        books = read("js/pages/books.js")
        body = books[books.index("function popIn(node)"):]
        body = body[:body.index("\n}") + 2]
        self.assertLess(body.index("void node.offsetWidth"), body.index("node.classList.add('is-open')"))
        self.assertEqual(len(live_matches(books, r"popIn\((?:menu|panel)\)")), 3)
        # Their overlay is a plain catcher: it never fades the popover itself.
        self.assertFalse(live_matches(books, r"el\('div', 'ws-dialog fixed"))
        self.assertEqual(len(live_matches(books, r"\.classList\.remove\('is-open'\);")), 3 + 2)
        cal = read("js/pages/calendar.js")
        self.assertFalse(live_matches(cal, r"panel\.classList\.(?:add|remove)\('hidden'\)"))
        self.assertTrue(live_matches(cal, r"WS\.popOpen\(panel\)") and live_matches(cal, r"WS\.popClose\(panel\)"))
        reader = read("js/pages/reader.js")
        self.assertTrue(live_matches(reader, r"shellPop\.popOpen\(el\('settingsPanel'\)\)"))

    def test_the_bell_opens_full(self):
        # The list read before is drawn before the panel opens, and read at
        # start-up, so the panel never opens short and grows.
        notif = read("js/notifications.js")
        body = notif[notif.index("function openDropdown(bell)"):]
        body = body[:body.index("\n  }\n")]
        self.assertLess(body.index("if (_items) renderItems(_items);"), body.index("WS.popOpen(_dropdown)"))
        init = notif[notif.index("function init()"):]
        self.assertRegex(init, r"updateBadge\(count\);\s*buildDropdown\(\);\s*loadDropdownItems\(\);")

    def test_the_player_drop_down_runs_the_same_motion(self):
        pop = css_rule(THEME, ".ws-pop")
        opened = css_rule(THEME, ".ws-pop.is-open")
        close_ms = set(re.findall(r"(\d+)ms", pop))
        open_ms = re.search(r"transition-duration: (\d+)ms", opened).group(1)
        self.assertEqual(close_ms, {"140"})
        self.assertEqual(open_ms, "220")
        self.assertIn("animation: wsp-win-in 220ms ease-out both;", css_rule(THEME, ".wsp-full.is-window.is-opening"))
        self.assertIn("animation: wsp-win-out 140ms ease-out both;", css_rule(THEME, ".wsp-full.is-window.is-closing"))
        frames = re.search(r"@keyframes wsp-win-in \{(.*?)\n\}", THEME, flags=re.S).group(1)
        self.assertIn("from { opacity: 0; transform: translateY(-6px); clip-path: inset(-24px -24px 100% -24px); }", frames)
        self.assertIn("transform: translateY(-6px)", pop)
        self.assertIn("clip-path: inset(-24px -24px 100% -24px)", pop)
        ui = read("js/player/ui.js")
        self.assertRegex(ui, r"export const WIN_IN_MS = 220;")
        self.assertRegex(ui, r"export const WIN_OUT_MS = 140;")

    def test_sheets_and_dialogs_keep_the_same_timing(self):
        self.assertIn("transition: transform 220ms", css_rule(THEME, ".ws-sheet.is-open .ws-sheet-panel"))
        self.assertIn("transition-duration: 220ms", css_rule(THEME, ".ws-sheet.is-open .ws-sheet-scrim"))
        panel = re.search(r"\n\.ws-sheet-panel \{([^}]*)\}", THEME).group(1)
        self.assertIn("transition: transform 140ms", panel)
        self.assertIn("opacity 140ms", re.search(r"\n\.ws-sheet-scrim \{([^}]*)\}", THEME).group(1))
        self.assertIn("animation: ws-dialog-in 220ms", css_rule(THEME, ".ws-dialog > .ws-dialog-box"))
        self.assertIn("transition-duration: 140ms", css_rule(THEME, ".ws-dialog.is-closing"))
        # The JS that waits a close out never cuts it short.
        for rel in ("js/shell.js", "js/status-panel.js", "js/pages/books.js"):
            m = re.search(r"SHEET_CLOSE_MS = (\d+);", read(rel))
            self.assertTrue(m and int(m.group(1)) >= 140, rel)

    def test_reduced_motion_stills_them(self):
        css = re.sub(r"/\*.*?\*/", "", THEME, flags=re.S)
        reduced = "".join(re.findall(r"@media \(prefers-reduced-motion: reduce\) \{(.*?)\n\}", css, flags=re.S))
        self.assertRegex(reduced, r"\.ws-pop, \.ws-dialog[^{]*\{ transition: none; \}")
        self.assertIn(".ws-sheet-panel, .ws-sheet.is-open .ws-sheet-panel { transform: none;", reduced)
        self.assertIn(".wsp-full.is-window.is-opening { animation: wsp-fade-in", reduced)


if __name__ == "__main__":
    unittest.main()
