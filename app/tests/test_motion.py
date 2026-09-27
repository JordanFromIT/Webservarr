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

from app.tests.test_shell_contract import STATIC, js_code_only, live_matches, matching_brace

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
        # The header pill is a .ws-pill: its tint, border and dot take the
        # state's token (test_theme_engine pins the words' colour).
        self.assertRegex(HEADER, r'id="systemStatus" data-state="unknown" class="ws-pill\b')
        for state in ("ok", "warn", "err"):
            self.assertIn(f"--ws-pill: var(--ws-status-{state})",
                          css_rule(THEME, f'.ws-pill[data-state="{state}"]'))
        self.assertIn("var(--ws-status-off)", css_rule(THEME, ".ws-pill"))
        # The label is theme text; a status colour tints it only on warn or err.
        self.assertRegex(HEADER, r'data-status-text class="ws-pill-label text-frosted-blue\b')

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
        # The timer is the fallback only, it is kept and cancelled by a reopen
        # or another close (a stale one must never hide a reopened drawer),
        # and reduced motion hides at once whatever the support.
        self.assertFalse(re.search(r"setTimeout\(function \(\) \{ overlay\.classList\.add\('hidden'\); \}, 300\)", SHELL_JS))
        self.assertTrue(live_matches(SHELL_JS, r"hideTimer = setTimeout\("))
        self.assertTrue(live_matches(SHELL_JS, r"clearTimeout\(hideTimer\)"))
        self.assertTrue(live_matches(SHELL_JS, r"if \(discrete \|\| reducedMotion\(\)\) overlay\.classList\.add\('hidden'\);"))
        # cancelHide clears the pending timer before it forgets it: nulling
        # the handle first would leave that timer running, unreachable, to
        # hide a reopened drawer.
        m = live_matches(SHELL_JS, r"function cancelHide\(\) \{")
        self.assertTrue(m, "cancelHide")
        body = SHELL_JS[m[0].end():matching_brace(SHELL_JS, m[0].end() - 1)]
        clear = live_matches(body, r"clearTimeout\(hideTimer\)")
        forget = live_matches(body, r"\bhideTimer = null\b")
        self.assertTrue(clear, "cancelHide must clear the timer")
        self.assertTrue(forget, "cancelHide must drop the handle")
        self.assertLess(clear[0].start(), forget[0].start(),
                        "cancelHide nulls hideTimer before clearing it")
        for fn in ("openDrawer", "closeDrawer"):
            m = live_matches(SHELL_JS, rf"function {fn}\(\) \{{")
            self.assertTrue(m, fn)
            body = SHELL_JS[m[0].end():matching_brace(SHELL_JS, m[0].end() - 1)]
            self.assertTrue(live_matches(body, r"cancelHide\(\);"), f"{fn} must cancel a pending hide")

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
        # The shadow is the theme's shade (the background darkened), so it
        # shows on a light page too (test_theme_engine.MotionFollowsTheTheme).
        self.assertIn("var(--ws-shade)", css_rule(hover.group(1), ".ws-lift:hover"))
        self.assertIn("transform: none", css_rule(THEME, '.ws-lift:disabled, .ws-lift[aria-disabled="true"]'))

    def test_lift_sits_only_on_what_is_clicked(self):
        # A lift promises a click. Cards that only hold a button (news, search
        # results, request status, streams, service tiles) carry none; the
        # requests discover poster is itself the click target and keeps it,
        # the search card's own Request button takes it, and so do a collapsed
        # integration card (its header button fills it) and the WSUI buttons.
        index = (STATIC / "index.html").read_text(encoding="utf-8")
        news = (STATIC / "news.html").read_text(encoding="utf-8")
        requests = (STATIC / "requests.html").read_text(encoding="utf-8")
        self.assertNotIn("ws-lift", index)
        self.assertNotIn("ws-lift", news)
        self.assertEqual(len(re.findall(r'class="[^"]*\bws-lift\b', requests)), 2)   # in markup, not in comments
        self.assertIn('glass-card ws-lift cursor-pointer group"', requests)                      # discover poster
        self.assertRegex(requests, r'data-request-id="[^"]*" class="ws-lift w-full')          # search card button
        self.assertNotRegex(requests, r'<div class="glass-card ws-lift')                       # no inert card
        self.assertIn("'ws-lift scroll-mt-6 rounded-2xl", INTEGRATIONS_JS)
        self.assertTrue(live_matches(INTEGRATIONS_JS, r"""root\.classList\.toggle\(\s*['"]ws-lift['"]\s*,\s*!open\s*\)"""))
        for btn in ("btnPrimary", "btnGhost", "btnDanger"):
            self.assertRegex(UI_JS, rf"\b{btn}: 'ws-lift inline-flex", btn)
        self.assertRegex(UI_JS, r"\bbtnQuiet: 'inline-flex")

    def test_a_dragged_row_neither_dips_nor_lifts_its_cards(self):
        # WS.dragScroll holds the mouse down across the whole gesture, which
        # would otherwise keep the card under the pointer pressed and lift the
        # ones it passes. The guard shares the hover/press specificity and
        # comes after both, so it wins the cascade.
        guard = css_rule(THEME, ".ws-dragging .ws-lift, .ws-dragging.ws-lift")
        self.assertIn("transform: none", guard)
        self.assertIn("box-shadow: none", guard)
        plain = top_level(THEME)
        self.assertGreater(plain.index(".ws-dragging .ws-lift"), plain.index(".ws-lift:active"))
        self.assertGreater(THEME.index(".ws-dragging .ws-lift"), THEME.index(".ws-lift:hover {"))

    def test_reduced_motion_drops_the_lift(self):
        self.assertTrue(stilled(THEME, ".ws-lift", "transition"))
        self.assertTrue(stilled(THEME, ".ws-lift:hover", "transform"))
        self.assertTrue(stilled(THEME, ".ws-lift:active", "transform"))


class LoginDrift(unittest.TestCase):
    """Ken Burns on the login artwork: one move per picture, restarted by the
    script as the picture is about to fade in, about 1% of scale a second so
    it is seen to move; a lone picture drifts back and forth instead."""

    def test_each_picture_moves_about_one_percent_a_second_on_transform_only(self):
        # The move is the script's to start (.is-moving), not the slide's own.
        self.assertNotIn("animation", properties(css_rule(LOGIN, ".backdrop-slide")))
        moving = css_rule(LOGIN, ".backdrop-slide.is-moving")
        m = re.search(r"animation: login-drift (\d+)s linear forwards", moving)
        self.assertTrue(m, moving)
        seconds = int(m.group(1))
        self.assertEqual(keyframe_properties(LOGIN, "login-drift"), {"transform"})
        end = re.search(r"to\s*\{ transform: scale\((1\.\d+)\) translate\(var\(--drift-x, 0%\), var\(--drift-y, 0%\)\)", LOGIN)
        self.assertTrue(end, "login-drift ends at a scale with a per-picture pan")
        scale = float(end.group(1))
        # Linear and about 1%/s, and it outlasts the ~11.5s a picture is on
        # screen (10s interval + 1.5s fade), so it never visibly stops.
        self.assertAlmostEqual((scale - 1) / seconds, 0.01, delta=0.002)
        self.assertGreaterEqual(seconds, 12)
        self.assertLessEqual(seconds, 16)

    def test_a_picture_that_overstays_keeps_moving_from_where_the_move_ended(self):
        # The next preload can run late or fail, and then nothing restarts
        # the move: a forwards hold would park the picture, fully zoomed.
        # A second animation takes over when the move ends, delayed by the
        # move's own duration, from the very state the move ends in.
        moving = css_rule(LOGIN, ".backdrop-slide.is-moving")
        m = re.search(r"animation: login-drift (\d+)s linear forwards,\s*"
                      r"login-drift-on (\d+)s linear (\d+)s infinite;", moving)
        self.assertTrue(m, moving)
        self.assertEqual(m.group(3), m.group(1), "the continuation starts when the move ends")
        self.assertGreaterEqual(int(m.group(2)), 24)
        self.assertEqual(keyframe_properties(LOGIN, "login-drift-on"), {"transform", "animation-timing-function"})
        move_end = re.search(r"@keyframes login-drift \{[^}]*\}\s*to\s*\{ transform: ([^;]+); \}", LOGIN)
        steps = re.search(r"@keyframes login-drift-on \{\s*"
                          r"0%\s*\{ transform: ([^;]+); animation-timing-function: ([^;]+); \}\s*"
                          r"50%\s*\{ transform: ([^;]+); animation-timing-function: ease-in-out; \}\s*"
                          r"100%\s*\{ transform: ([^;]+); \}", LOGIN)
        self.assertTrue(move_end and steps)
        # It starts and loops on the move's own end state, so there is no
        # jump either way, and its first leg leaves at nearly the move's
        # speed (an ease-in-out from rest would read as a stop): the curve's
        # first control point gives it about 2.25x the leg's average rate.
        self.assertEqual(steps.group(1), move_end.group(1))
        self.assertEqual(steps.group(4), move_end.group(1))
        self.assertEqual(steps.group(2), "cubic-bezier(0.2, 0.45, 0.5, 1)")
        # The far end also keeps the pan inside the overhang; the states
        # interpolate together, so the ends bound the whole drift.
        far = re.fullmatch(r"scale\((1\.\d+)\) translate\(calc\(var\(--drift-x, 0%\) \* ([\d.]+)\), "
                           r"calc\(var\(--drift-y, 0%\) \* \2\)\)", steps.group(3))
        self.assertTrue(far, "login-drift-on's far end is a scale with a scaled-up pan")
        scale, factor = float(far.group(1)), float(far.group(2))
        pan = max(abs(float(v)) for v in re.findall(r"--drift-[xy]: (-?[\d.]+)%", LOGIN))
        self.assertLessEqual(pan * factor / 100 * scale, (scale - 1) / 2)
        self.assertGreater(scale, 1.14)

    def test_four_directions_and_the_pan_never_uncovers_an_edge(self):
        pans = {}
        for name in ("nw", "ne", "sw", "se"):
            rule = css_rule(LOGIN, f".backdrop-slide.drift-{name}")
            m = re.fullmatch(r"\s*--drift-x: (-?\d+(?:\.\d+)?)%; --drift-y: (-?\d+(?:\.\d+)?)%;\s*", rule)
            self.assertTrue(m, rule)
            pans[name] = (float(m.group(1)), float(m.group(2)))
        # One class per corner: the signs cover all four quadrants.
        self.assertEqual({(x < 0, y < 0) for x, y in pans.values()},
                         {(True, True), (False, True), (True, False), (False, False)})
        # The translate is applied inside the scale, so the picture moves
        # pan * scale of the box; the overhang past each edge is (scale-1)/2.
        # Both grow from zero together, so holding at the end holds throughout.
        scale = float(re.search(r"transform: scale\((1\.\d+)\) translate\(var\(--drift-x", LOGIN).group(1))
        for x, y in pans.values():
            for pan in (x, y):
                self.assertLessEqual(abs(pan) / 100 * scale, (scale - 1) / 2)
        # A single picture: a slow back-and-forth that is also seen to move.
        solo = css_rule(LOGIN, ".backdrop-slide.is-solo")
        self.assertRegex(solo, r"animation: login-drift-solo (?:1[5-9]|2\d)s ease-in-out infinite alternate")
        self.assertEqual(keyframe_properties(LOGIN, "login-drift-solo"), {"transform"})
        m = re.search(r"to\s*\{ transform: scale\((1\.\d+)\) translate\((-?[\d.]+)%, (-?[\d.]+)%\)", LOGIN)
        self.assertTrue(m)
        solo_scale = float(m.group(1))
        self.assertGreaterEqual(solo_scale, 1.08)
        for pan in (float(m.group(2)), float(m.group(3))):
            self.assertLessEqual(abs(pan) / 100 * solo_scale, (solo_scale - 1) / 2)

    def test_reduced_motion_keeps_the_crossfade_and_drops_every_move(self):
        # The guard names the moving selectors themselves: a bare
        # .backdrop-slide has less specificity and would never win.
        self.assertTrue(stilled(LOGIN, ".backdrop-slide.is-moving", "animation"))
        self.assertTrue(stilled(LOGIN, ".backdrop-slide.is-solo", "animation"))
        self.assertIn("transition: opacity 1.5s ease-in-out", css_rule(LOGIN, ".backdrop-slide"))

    def test_the_move_restarts_before_the_incoming_slide_fades_in(self):
        # restartDrift: class off, a forced reflow, class on, in that order.
        m = live_matches(LOGIN, r"function restartDrift\(slide\) \{")
        self.assertTrue(m, "restartDrift")
        body = LOGIN[m[0].end():matching_brace(LOGIN, m[0].end() - 1)]
        off = live_matches(body, r"slide\.classList\.remove\('is-moving'")
        reflow = live_matches(body, r"void slide\.offsetWidth;")
        on = live_matches(body, r"slide\.classList\.add\('is-moving', DRIFTS\[lastDrift\]\)")
        self.assertTrue(off and reflow and on)
        self.assertLess(off[0].start(), reflow[0].start())
        self.assertLess(reflow[0].start(), on[0].start())
        # The next direction always differs from the last one.
        self.assertTrue(live_matches(
            body, r"lastDrift = \(lastDrift \+ 1 \+ Math\.floor\(Math\.random\(\) \* \(DRIFTS\.length - 1\)\)\) % DRIFTS\.length;"))
        self.assertTrue(live_matches(LOGIN, r"var DRIFTS = \['drift-nw', 'drift-ne', 'drift-sw', 'drift-se'\];"))
        # show(): the incoming slide restarts before its opacity goes to 1;
        # the outgoing slide's classes are left alone.
        m = live_matches(LOGIN, r"function show\(next, prev, url\) \{")
        self.assertTrue(m, "show")
        body = LOGIN[m[0].end():matching_brace(LOGIN, m[0].end() - 1)]
        restart = live_matches(body, r"restartDrift\(next\);")
        fade_in = live_matches(body, r"next\.style\.opacity = '1';")
        self.assertTrue(restart and fade_in)
        self.assertLess(restart[0].start(), fade_in[0].start())
        self.assertTrue(live_matches(body, r"prev\.style\.opacity = '0';"))
        self.assertFalse(re.search(r"prev\.classList", body))
        # A preload that lands after a newer tick started is dropped: shown,
        # it would reset the slide the newer picture is fading in on, in view.
        seq = live_matches(LOGIN, r"var seq = \+\+rotation;")
        wait = live_matches(LOGIN, r"await preload\(nextUrl\);")
        stale = live_matches(LOGIN, r"if \(seq !== rotation\) return;")
        self.assertTrue(seq and wait and stale)
        self.assertLess(seq[0].start(), wait[0].start())
        self.assertLess(wait[0].start(), stale[0].start())
        self.assertLess(stale[0].start(), live_matches(LOGIN, r"show\(slideB, slideA, nextUrl\);")[0].start())
        # The first picture starts once the slideshow is shown, before it
        # fades in; a lone picture takes the back-and-forth drift instead.
        reveal = live_matches(LOGIN, r"slideshow\.classList\.remove\('hidden'\);")
        first = live_matches(LOGIN, r"if \(urls\.length < 2\) slideA\.classList\.add\('is-solo'\); else restartDrift\(slideA\);")
        shown = live_matches(LOGIN, r"slideA\.style\.opacity = '1';")
        self.assertTrue(reveal and first and shown)
        self.assertLess(reveal[0].start(), first[0].start())
        self.assertLess(first[0].start(), shown[0].start())

    def test_no_new_timers_drive_the_move(self):
        # The rotation interval and the Plex PIN poll; the message clear, the
        # Plex retry and the form-reveal failsafe. Nothing animates from JS.
        code = js_code_only(LOGIN)
        self.assertEqual(code.count("setInterval("), 2)
        self.assertEqual(code.count("setTimeout("), 3)
        self.assertNotIn("requestAnimationFrame", code)
        self.assertNotIn(".animate(", code)

    def test_the_card_glass_and_the_form_reveal_are_untouched(self):
        glass = css_rule(LOGIN, ".login-glass-card")
        self.assertIn("rgb(var(--color-secondary) / 0.10)", glass)
        self.assertIn("backdrop-filter: blur(4px)", glass)
        self.assertIn("#loginForm { visibility: hidden; }", LOGIN)
        self.assertIn("#loginForm.auth-ready { visibility: visible; }", LOGIN)


if __name__ == "__main__":
    unittest.main()
