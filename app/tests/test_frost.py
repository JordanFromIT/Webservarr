"""
One frosted surface and one popover motion for everything that floats.

The frost (theme.css .ws-frost and its --ws-frost-* tokens) is the sign-in
card's glass, measured from login.html: the secondary colour at 10% over a
4px blur, an accent edge at 20% and Tailwind's shadow-2xl. Every menu,
popover, panel, sheet, dialog and toast wears it, and none carries a recipe of
its own. A floor of the page colour under the tint keeps text readable over a
white poster (the sign-in card gets the same from its page's dark overlay);
the contrast checks here pin that it does, for the default palette.

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
    m = re.search(r"\n  " + re.escape(name) + r": ([^;]+);", THEME)
    assert m, name
    return m.group(1).strip()


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


def frosted(behind, floor):
    """What the frost paints over `behind`: the floor, then the tint."""
    tint = alpha_of(token("--ws-frost-tint"))
    return over(default_rgb("secondary"), tint, over(default_rgb("background"), floor, behind))


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
    def test_the_tokens_are_the_sign_in_cards_glass(self):
        card = re.search(r"\.login-glass-card \{([^}]*)\}", LOGIN).group(1)
        self.assertIn("background: rgb(var(--color-secondary) / 0.10);", card)
        self.assertEqual(token("--ws-frost-tint"), "rgb(var(--color-secondary) / .10)")
        self.assertIn("backdrop-filter: blur(4px);", card)
        self.assertEqual(token("--ws-frost-blur"), "blur(4px)")
        self.assertIn("border: 1px solid rgb(var(--color-accent) / 0.2);", card)
        self.assertEqual(token("--ws-frost-edge"), "rgb(var(--color-accent) / .2)")
        # The card's shadow is Tailwind's shadow-2xl (its class in login.html).
        self.assertRegex(LOGIN, r'class="[^"]*\blogin-glass-card\b[^"]*\bshadow-2xl\b')
        self.assertIn(".shadow-2xl{--tw-shadow:0 25px 50px -12px rgba(0,0,0,.25)", APP_CSS)
        self.assertEqual(token("--ws-frost-shadow"), "0 25px 50px -12px rgb(0 0 0 / .25)")

    def test_the_class_paints_only_the_tokens(self):
        rule = re.search(r"\n\.ws-frost \{([^}]*)\}", THEME).group(1)
        self.assertIn("background: linear-gradient(var(--ws-frost-tint), var(--ws-frost-tint)), "
                      "rgb(var(--color-background) / var(--ws-frost-floor));", rule)
        self.assertIn("-webkit-backdrop-filter: var(--ws-frost-blur);", rule)
        self.assertIn("backdrop-filter: var(--ws-frost-blur);", rule)
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

    def test_the_player_drop_down_paints_the_tokens(self):
        rule = css_rule(THEME, ".wsp-full.is-window")
        self.assertIn("background: linear-gradient(var(--ws-frost-tint), var(--ws-frost-tint)), "
                      "rgb(var(--color-background) / var(--ws-frost-floor));", rule)
        self.assertIn("backdrop-filter: var(--ws-frost-blur);", rule)
        self.assertIn("border: 1px solid var(--ws-frost-edge);", rule)
        self.assertIn("box-shadow: var(--ws-frost-shadow);", rule)
        # Its pointer is the same frost, cut to the half above the window's edge.
        caret = css_rule(THEME, ".wsp-full.is-window:not(.is-pip) .wsp-drop-caret")
        self.assertIn("clip-path: polygon(0 0, 100% 0, 0 100%);", caret)
        self.assertIn("var(--ws-frost-floor)", caret)


class FrostContrast(unittest.TestCase):
    """The default palette over a white poster, the worst thing that can be behind."""

    def test_text_at_70_percent_keeps_4_5_to_1_over_white(self):
        floor = float(token("--ws-frost-floor"))
        bg = frosted(WHITE, floor)
        for a in (1.0, 0.85, 0.8, 0.7):
            text = over(default_rgb("text"), a, bg)
            self.assertGreaterEqual(ratio(text, bg), 4.5, f"text/{a} over white: {ratio(text, bg):.2f}")

    def test_the_floor_is_the_least_that_does(self):
        # A floor any lower and 70% text drops under 4.5:1: no darker than it must be.
        floor = float(token("--ws-frost-floor")) - 0.02
        bg = frosted(WHITE, floor)
        self.assertLess(ratio(over(default_rgb("text"), 0.7, bg), bg), 4.5)

    def test_the_bare_glass_would_not(self):
        # Why the floor exists: the sign-in card's glass alone over white.
        bg = frosted(WHITE, 0)
        self.assertLess(ratio(default_rgb("text"), bg), 1.5)

    def test_on_a_scrim_it_comes_level(self):
        # A sheet or a dialog: the scrim (page colour at .7) then the small floor
        # dims what is behind at least as much as a popover's floor does.
        for rule in (css_rule(THEME, ".ws-scrim"), re.search(r"\n\.ws-sheet-scrim \{([^}]*)\}", THEME).group(1)):
            scrim = float(re.search(r"background(?:-color)?: rgb\(var\(--color-background\) / (\.?\d+)\)", rule).group(1))
            on = float(token("--ws-frost-floor-on-scrim"))
            behind = over(default_rgb("background"), scrim, WHITE)
            bg = frosted(behind, on)
            self.assertGreaterEqual(1 - (1 - scrim) * (1 - on), float(token("--ws-frost-floor")))
            self.assertGreaterEqual(ratio(over(default_rgb("text"), 0.7, bg), bg), 4.5)

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
