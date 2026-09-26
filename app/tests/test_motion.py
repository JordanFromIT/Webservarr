"""
The shell's motion touches: small, composite-only, and off under reduced motion.

Five touches (soft open/close of menus, the bell panel, the drawer and the
WSUI dialog; the sidebar highlight gliding between pages; a pixel of lift on
cards and buttons; the login artwork's slow drift; the live status pill).
Each check pins the code a touch needs, so a cleanup that drops a guard,
brings a timer back, or puts a palette class on the status pill fails here.

Run inside the container:
    python -m unittest discover -s /app/app/tests -t /app -v
"""
import re
import unittest

from app.tests.test_shell_contract import STATIC, js_code_only, live_matches

THEME = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
LOGIN = (STATIC / "login.html").read_text(encoding="utf-8")
HEADER = (STATIC / "partials" / "shell-header.html").read_text(encoding="utf-8")
SIDEBAR = (STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8")
SHELL_JS = (STATIC / "js" / "shell.js").read_text(encoding="utf-8")
UI_JS = (STATIC / "js" / "ui.js").read_text(encoding="utf-8")
NOTIF_JS = (STATIC / "js" / "notifications.js").read_text(encoding="utf-8")
INTEGRATIONS_JS = (STATIC / "js" / "settings" / "integrations.js").read_text(encoding="utf-8")

# Tailwind palette colours on the shell: the status pill's tint, dot and label
# used to be swapped in from these; every colour now comes from a token.
PALETTE = r"\b(?:bg|text|border|ring)-(?:green|yellow|amber|red|rose|emerald|slate|gray|zinc)-\d{3}\b"


def top_level(css: str) -> str:
    """The stylesheet without the bodies of its at-rules (@media,
    @starting-style, @keyframes...), so a selector's plain rule can be found
    apart from the copies that redefine it under a condition. Comments go
    first: one that mentions an at-rule must not read as one."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    out, i = [], 0
    while True:
        m = re.search(r"@[\w-]+[^{};]*\{", css[i:])
        if not m:
            out.append(css[i:])
            return "".join(out)
        out.append(css[i:i + m.start()])
        depth, j = 0, i + m.start()
        while j < len(css):
            if css[j] == "{":
                depth += 1
            elif css[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        i = j + 1


def css_rule(css: str, selector: str) -> str:
    """The declarations of the one top-level rule written for exactly this
    selector (pass a block's own text to look inside an at-rule)."""
    found = re.findall(re.escape(selector) + r"\s*\{([^{}]*)\}", top_level(css))
    assert len(found) == 1, f"{selector}: {len(found)} rules"
    return found[0]


def properties(block: str) -> set:
    return {d.split(":", 1)[0].strip() for d in block.split(";") if d.strip()}


def keyframe_properties(css: str, name: str) -> set:
    """Every property any keyframe of the named animation sets."""
    m = re.search(r"@keyframes " + re.escape(name) + r"\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}", css)
    assert m, name
    props = set()
    for step in re.finditer(r"\{([^{}]*)\}", m.group(1)):
        props |= properties(step.group(1))
    return props


def reduced_blocks(css: str) -> list:
    """The bodies of the reduced-motion media blocks (one rule per line, the
    block closing on a line of its own, as theme.css writes them)."""
    return re.findall(r"@media \(prefers-reduced-motion: reduce\)\s*\{(.*?)\n\s*\}", css, re.S)


def stilled(css: str, selector: str, prop: str) -> bool:
    """Some reduced-motion block names the selector and sets prop: none on it."""
    for block in reduced_blocks(css):
        for rule in re.finditer(r"([^{}]+)\{([^{}]*)\}", block):
            selectors = [s.strip() for s in rule.group(1).split(",")]
            if selector in selectors and re.search(rf"\b{re.escape(prop)}:\s*none\b", rule.group(2)):
                return True
    return False


class StatusPill(unittest.TestCase):
    def test_colours_are_status_tokens_not_palette_classes(self):
        self.assertNotRegex(SHELL_JS, PALETTE)
        self.assertNotRegex(HEADER, PALETTE)
        self.assertNotIn("animate-pulse", SHELL_JS)
        for state in ("ok", "warn", "err"):
            self.assertIn(f"--ws-pill: var(--ws-status-{state})",
                          css_rule(THEME, f'#systemStatus[data-state="{state}"]'))
        self.assertIn("var(--ws-status-off)", css_rule(THEME, "#systemStatus"))
        # The label is theme text; status tokens are for non-text marks only.
        self.assertRegex(HEADER, r'data-status-text class="text-frosted-blue\b')

    def test_only_online_pings_and_the_ring_never_touches_layout(self):
        ring = css_rule(THEME, '#systemStatus[data-state="ok"] .ws-status-dot::after')
        self.assertRegex(ring, r"animation:\s*ws-ping\s+2\.\d+s")
        self.assertNotRegex(THEME, r'data-state="(?:warn|err|unknown)"\]\s*\.ws-status-dot::after')
        self.assertEqual(keyframe_properties(THEME, "ws-ping"), {"transform", "opacity"})
        dot = css_rule(THEME, ".ws-status-dot")
        self.assertIn("width: .5rem", dot)
        self.assertIn("height: .5rem", dot)
        self.assertRegex(HEADER, r'data-status-dot class="ws-status-dot"')
        # The guard must carry the ping rule's own selector: a shorter one
        # (.ws-status-dot::after) has less specificity and never applies.
        self.assertTrue(stilled(THEME, '#systemStatus[data-state="ok"] .ws-status-dot::after', "animation"))

    def test_script_sets_the_state_and_the_words_only(self):
        self.assertRegex(SHELL_JS, r"PILL_LABEL\s*=\s*\{[^}]*\bok:[^}]*\bwarn:[^}]*\berr:")
        self.assertTrue(live_matches(SHELL_JS, r"""pill\.setAttribute\(\s*['"]data-state['"]\s*,\s*state\s*\)"""))
        # No class lists swapped onto the pill or the dot any more.
        self.assertFalse(live_matches(SHELL_JS, r"\b(?:pill|dot)\.className\s*="))


class SoftOpenClose(unittest.TestCase):
    def test_menus_and_the_bell_panel_carry_ws_pop_and_hide_through_the_class(self):
        self.assertIn('id="userMenuDropdown" class="ws-pop hidden ', HEADER)
        self.assertIn('id="mobileUserMenuDropdown" class="ws-pop hidden ', SIDEBAR)
        self.assertIn("'ws-pop hidden absolute", NOTIF_JS)
        self.assertTrue(live_matches(NOTIF_JS, r"""_dropdown\.classList\.add\(\s*['"]hidden['"]\s*\)"""))
        self.assertTrue(live_matches(NOTIF_JS, r"""_dropdown\.classList\.remove\(\s*['"]hidden['"]\s*\)"""))
        self.assertFalse(live_matches(NOTIF_JS, r"_dropdown\.style\.display\b"))

    def test_ws_pop_fades_through_a_discrete_display_transition(self):
        self.assertRegex(css_rule(THEME, ".ws-pop"), r"display \d+ms allow-discrete")
        closed = css_rule(THEME, ".ws-pop.hidden")
        self.assertIn("pointer-events: none", closed)
        self.assertIn("opacity: 0", closed)
        self.assertRegex(closed, r"transform: translateY\(-\d+px\)")
        self.assertRegex(THEME, r"@starting-style\s*\{\s*\.ws-pop\s*\{[^}]*opacity: 0")

    def test_drawer_overlay_is_hidden_by_the_stylesheet_not_a_timer(self):
        self.assertIn("pointer-events: none", css_rule(THEME, "#drawerOverlay.hidden"))
        self.assertRegex(css_rule(THEME, "#drawerOverlay"), r"display \d+ms allow-discrete")
        self.assertEqual(properties(css_rule(THEME, "#drawerPanel")), {"transition"})
        self.assertNotRegex(SIDEBAR, r'id="drawerPanel"[^>]*\b(?:duration-\d+|transition-transform)\b')
        self.assertTrue(live_matches(
            SHELL_JS, r"""CSS\.supports\(\s*['"]transition-behavior['"]\s*,\s*['"]allow-discrete['"]\s*\)"""))
        # The timer is the fallback only: no unconditional delay hides the overlay.
        self.assertFalse(re.search(r"setTimeout\(function \(\) \{ overlay\.classList\.add\('hidden'\); \}, 300\)", SHELL_JS))

    def test_dialog_close_is_inert_before_focus_returns_then_leaves_the_dom(self):
        inert = live_matches(UI_JS, r"overlay\.inert\s*=\s*true")
        self.assertTrue(inert)
        self.assertTrue(live_matches(UI_JS, r"""overlay\.classList\.add\(\s*['"]is-closing['"]\s*\)"""))
        self.assertTrue(live_matches(UI_JS, r"setTimeout\(\s*remove\s*,\s*\d+\s*\)"))
        self.assertTrue(live_matches(UI_JS, r"if \(reducedMotion\(\)\) remove\(\);"))
        back = live_matches(UI_JS, r"back\.focus\(")
        self.assertTrue(back)
        self.assertLess(inert[0].start(), back[0].start(), "the overlay must be inert before focus moves")
        self.assertIn("pointer-events: none", css_rule(THEME, ".ws-dialog.is-closing"))
        self.assertIn("'ws-dialog fixed inset-0", UI_JS)
        self.assertIn("'ws-dialog-box w-full", UI_JS)
        self.assertEqual(keyframe_properties(THEME, "ws-dialog-in"), {"transform", "opacity"})

    def test_reduced_motion_makes_every_open_and_close_instant(self):
        for sel in (".ws-pop", "#drawerOverlay", "#drawerPanel", ".ws-dialog"):
            self.assertTrue(stilled(THEME, sel, "transition"), sel)
        self.assertTrue(stilled(THEME, ".ws-dialog > .ws-dialog-box", "animation"))

    def test_no_new_intervals(self):
        # WS.poll owns the one interval in shell.js; the touches add none.
        self.assertEqual(js_code_only(SHELL_JS).count("setInterval("), 1)
        self.assertNotIn("setInterval", js_code_only(UI_JS))


class NavHighlight(unittest.TestCase):
    def test_desktop_highlight_is_named_and_the_drawer_copy_is_not(self):
        self.assertIn("view-transition-name: ws-nav-active",
                      css_rule(THEME, '#desktopNav a[aria-current="page"]'))
        self.assertNotRegex(THEME, r"#drawerNav[^{]*\{[^}]*view-transition-name")
        group = css_rule(THEME, "::view-transition-group(ws-nav-active)")
        self.assertRegex(group, r"animation-duration:\s*2[0-5]\dms")
        # One image glides; nothing crossfades or doubles.
        self.assertIn("display: none", css_rule(THEME, "::view-transition-old(ws-nav-active)"))
        self.assertIn("animation: none", css_rule(THEME, "::view-transition-new(ws-nav-active)"))

    def test_cross_document_transitions_stay_off_under_reduced_motion(self):
        self.assertTrue(any("@view-transition { navigation: none; }" in b for b in reduced_blocks(THEME)))


class HoverLift(unittest.TestCase):
    def test_lift_moves_transform_and_shadow_only_and_hovers_only_for_a_pointer(self):
        hover = re.search(r"@media \(hover: hover\) and \(pointer: fine\)\s*\{(.*?)\n\}", THEME, re.S)
        self.assertIsNotNone(hover)
        self.assertLessEqual(properties(css_rule(hover.group(1), ".ws-lift:hover")), {"transform", "box-shadow"})
        self.assertLessEqual(properties(css_rule(THEME, ".ws-lift:active")), {"transform", "transition-duration"})
        self.assertRegex(css_rule(hover.group(1), ".ws-lift:hover"), r"translateY\(-[12]px\)")
        self.assertIn("rgb(var(--color-background)", css_rule(hover.group(1), ".ws-lift:hover"))
        self.assertIn("transform: none", css_rule(THEME, '.ws-lift:disabled, .ws-lift[aria-disabled="true"]'))

    def test_listed_surfaces_carry_the_class(self):
        index = (STATIC / "index.html").read_text(encoding="utf-8")
        self.assertIn('class="glass-card ws-lift p-4 rounded-xl', index)                   # news card
        self.assertIn('class="glass-card ws-lift rounded-xl overflow-hidden group"', index)  # stream card
        self.assertIn('class="ws-lift bg-baltic-blue/10 rounded-xl', index)                # service tile
        self.assertIn('class="glass-card ws-lift p-4 rounded-xl', (STATIC / "news.html").read_text(encoding="utf-8"))
        requests = (STATIC / "requests.html").read_text(encoding="utf-8")
        self.assertEqual(requests.count("glass-card ws-lift"), 3)
        self.assertIn("'ws-lift scroll-mt-6 rounded-2xl", INTEGRATIONS_JS)
        self.assertTrue(live_matches(INTEGRATIONS_JS, r"""root\.classList\.toggle\(\s*['"]ws-lift['"]\s*,\s*!open\s*\)"""))
        for btn in ("btnPrimary", "btnGhost", "btnDanger"):
            self.assertRegex(UI_JS, rf"\b{btn}: 'ws-lift inline-flex", btn)
        self.assertRegex(UI_JS, r"\bbtnQuiet: 'inline-flex")

    def test_reduced_motion_drops_the_lift(self):
        self.assertTrue(stilled(THEME, ".ws-lift", "transition"))
        self.assertTrue(stilled(THEME, ".ws-lift:hover", "transform"))
        self.assertTrue(stilled(THEME, ".ws-lift:active", "transform"))


class LoginDrift(unittest.TestCase):
    def test_backdrop_drifts_on_transform_only(self):
        slide = css_rule(LOGIN, ".backdrop-slide")
        self.assertRegex(slide, r"animation: login-drift (?:2[5-9]|3\d|40)s ease-in-out infinite alternate")
        self.assertEqual(keyframe_properties(LOGIN, "login-drift"), {"transform"})
        self.assertRegex(LOGIN, r"to\s*\{ transform: scale\(1\.0[6-8]\)")
        self.assertTrue(stilled(LOGIN, ".backdrop-slide", "animation"))

    def test_the_card_glass_and_the_form_reveal_are_untouched(self):
        glass = css_rule(LOGIN, ".login-glass-card")
        self.assertIn("rgb(var(--color-secondary) / 0.10)", glass)
        self.assertIn("backdrop-filter: blur(4px)", glass)
        self.assertIn("#loginForm { visibility: hidden; }", LOGIN)
        self.assertIn("#loginForm.auth-ready { visibility: visible; }", LOGIN)


if __name__ == "__main__":
    unittest.main()
