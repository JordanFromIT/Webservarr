"""
The shell's motion touches: small, composite-only, and off under reduced motion.

Four touches (soft open/close of menus, the bell panel, the drawer and the
WSUI dialog; a pixel of lift on cards and buttons; the login artwork's slow
drift; the live status pill). The sidebar highlight no longer glides: the
active item switches instantly (NavHighlight pins that).
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
# The login page's script, a file since the CSP became script-src 'self'.
LOGIN_JS = (STATIC / "js" / "login.js").read_text(encoding="utf-8")
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

    def test_only_a_change_pings_and_the_ring_never_touches_layout(self):
        # Audit M11 (2026-10-04): healthy is quiet. The ring leaves the dot
        # once, when the state turns to warn or err; an ok dot never moves.
        selector = '#systemStatus[data-state="err"] .ws-status-dot::after'
        rule = re.search(r'#systemStatus\[data-state="warn"\] \.ws-status-dot::after,\s*' + re.escape(selector) +
                         r'\s*\{([^}]*)\}', THEME)
        self.assertIsNotNone(rule)
        self.assertRegex(rule.group(1), r"animation:\s*ws-ping\s+1\.\d+s\s+cubic-bezier\([^)]*\)\s+1;")
        self.assertNotRegex(THEME, r'data-state="(?:ok|unknown)"\]\s*\.ws-status-dot::after')
        self.assertEqual(keyframe_properties(THEME, "ws-ping"), {"transform", "opacity"})
        dot = css_rule(THEME, ".ws-status-dot")
        self.assertIn("width: .5rem", dot)
        self.assertIn("height: .5rem", dot)
        self.assertRegex(HEADER, r'data-status-dot class="ws-status-dot"')
        # The guard must carry the ping rule's own selector: a shorter one
        # (.ws-status-dot::after) has less specificity and never applies.
        self.assertTrue(stilled(THEME, selector, "animation"))

    def test_script_sets_the_state_and_the_words_only(self):
        self.assertRegex(SHELL_JS, r"PILL_LABEL\s*=\s*\{[^}]*\bok:[^}]*\bwarn:[^}]*\berr:")
        self.assertTrue(live_matches(SHELL_JS, r"""pill\.setAttribute\(\s*['"]data-state['"]\s*,\s*state\s*\)"""))
        # No class lists swapped onto the pill or the dot any more.
        self.assertFalse(live_matches(SHELL_JS, r"\b(?:pill|dot)\.className\s*="))


def function_body(js: str, name: str) -> str:
    """The body of the named function declaration in js."""
    m = live_matches(js, rf"function {re.escape(name)}\([^)]*\) \{{")
    assert m, name
    return js[m[0].end():matching_brace(js, m[0].end() - 1)]


class SoftOpenClose(unittest.TestCase):
    def test_menus_and_the_bell_panel_carry_ws_pop_and_hide_through_the_class(self):
        self.assertIn('id="userMenuDropdown" class="ws-pop hidden ', HEADER)
        self.assertIn("'ws-pop hidden absolute", NOTIF_JS)
        self.assertTrue(live_matches(NOTIF_JS, r"WS\.popOpen\(_dropdown\)"))
        self.assertTrue(live_matches(NOTIF_JS, r"WS\.popClose\(_dropdown\)"))
        self.assertFalse(live_matches(NOTIF_JS, r"_dropdown\.classList\."))
        self.assertFalse(live_matches(NOTIF_JS, r"_dropdown\.style\.display\b"))

    def test_ws_pop_fades_through_a_discrete_display_transition(self):
        closed = css_rule(THEME, ".ws-pop")
        self.assertRegex(closed, r"display \d+ms allow-discrete")
        self.assertIn("pointer-events: none", closed)
        self.assertIn("opacity: 0", closed)
        self.assertRegex(closed, r"transform: translateY\(-\d+px\)")
        opened = css_rule(THEME, ".ws-pop.is-open")
        self.assertIn("opacity: 1", opened)
        self.assertIn("transform: none", opened)
        self.assertIn("pointer-events: auto", opened)
        # Open 150-220ms, close 120-160ms: the closed rule's durations are the
        # close, the open state's transition-duration is the open.
        for ms in re.findall(r"(\d+)ms", closed):
            self.assertTrue(120 <= int(ms) <= 160, closed)
        m = re.search(r"transition-duration: (\d+)ms", opened)
        self.assertTrue(m and 150 <= int(m.group(1)) <= 220, opened)
        # Every open unfolds from the top edge (not only the bell's first,
        # whose list arriving made it grow); the clip stays clear of the shadow.
        self.assertIn("clip-path: inset(-24px -24px 100% -24px)", closed)
        self.assertIn("clip-path 140ms ease-out", closed)
        self.assertIn("clip-path: inset(-24px -24px -24px -24px)", opened)

    def test_every_open_restarts_from_the_closed_state(self):
        # A panel whose open was left to @starting-style animated only the
        # first time in a browser that keeps its last style across a display
        # transition. Now no open depends on @starting-style: the open path
        # takes .hidden off, reflows so the closed state is drawn, then adds
        # .is-open, and close takes .is-open off again so the next open starts
        # from the closed state.
        self.assertNotRegex(THEME, r"@starting-style\s*\{[^}]*\.ws-pop\b")
        body = function_body(SHELL_JS, "popOpen")
        unhide = live_matches(body, r"el\.classList\.remove\('hidden'\)")
        reflow = live_matches(body, r"void el\.offset(?:Width|Height)")
        opened = live_matches(body, r"el\.classList\.add\('is-open'\)")
        self.assertTrue(unhide and reflow and opened, body)
        self.assertLess(unhide[0].start(), reflow[0].start(), "reflow after .hidden comes off")
        self.assertLess(reflow[0].start(), opened[0].start(), ".is-open only after the reflow")
        body = function_body(SHELL_JS, "popClose")
        self.assertTrue(live_matches(body, r"el\.classList\.remove\('is-open'\)"))
        self.assertTrue(live_matches(body, r"el\.classList\.add\('hidden'\)"))
        # The account menus go through the helpers and never toggle .hidden
        # themselves; the bell in notifications.js uses the same two.
        self.assertFalse(live_matches(SHELL_JS, r"menu\.classList\."))
        # (expanded(false): the button's aria-expanded follows the menu.)
        self.assertTrue(live_matches(SHELL_JS, r"if \(popIsOpen\(menu\)\) \{ popClose\(menu\); expanded\(false\); return; \}"))
        self.assertTrue(live_matches(SHELL_JS, r"popOpen\(menu\);"))
        self.assertRegex(js_code_only(SHELL_JS), r"popOpen: popOpen,\s*popClose: popClose,\s*popIsOpen: popIsOpen,")
        # The phone's More sheet: the same two states. It is shown (showModal)
        # and drawn closed before .is-open, and loses .is-open on close.
        self.assertIn("opacity: 0", re.search(r"\n\.ws-sheet-scrim \{([^}]*)\}", THEME).group(1))
        self.assertIn("opacity: 1", css_rule(THEME, ".ws-sheet.is-open .ws-sheet-scrim"))
        body = function_body(SHELL_JS, "open")
        shown = live_matches(body, r"sheet\.showModal\(\)")
        reflow = live_matches(body, r"void panel\.offsetHeight")
        opened = live_matches(body, r"sheet\.classList\.add\('is-open'\)")
        self.assertTrue(shown and reflow and opened, body)
        self.assertLess(shown[0].start(), reflow[0].start())
        self.assertLess(reflow[0].start(), opened[0].start())
        self.assertTrue(live_matches(function_body(SHELL_JS, "close"), r"sheet\.classList\.remove\('is-open'\)"))

    def test_the_sheet_closes_after_its_slide_and_never_late(self):
        # The More sheet stays open (modal) for its slide, then closes; a
        # reopen or a close "now" (a page swap) ends a pending close first,
        # so a stale timer can never close a sheet opened again. Reduced
        # motion closes at once.
        close = function_body(SHELL_JS, "close")
        self.assertTrue(live_matches(close, r"hideTimer = setTimeout\(function \(\) \{ finish\(restore\); \}, SHEET_CLOSE_MS\);"))
        self.assertTrue(live_matches(close, r"if \(now \|\| reducedMotion\(\)\) \{ finish\(restore\); return; \}"))
        finish = function_body(SHELL_JS, "finish")
        clear = live_matches(finish, r"clearTimeout\(hideTimer\)")
        forget = live_matches(finish, r"\bhideTimer = null\b")
        self.assertTrue(clear and forget)
        self.assertLess(clear[0].start(), forget[0].start(), "finish nulls hideTimer before clearing it")
        self.assertTrue(live_matches(function_body(SHELL_JS, "open"), r"finish\(false\);"))
        self.assertIn("pointer-events: none", css_rule(THEME, ".ws-sheet.is-closing"))

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
        self.assertIn("'ws-dialog-box ws-frost w-full", UI_JS)
        self.assertEqual(keyframe_properties(THEME, "ws-dialog-in"), {"transform", "opacity"})

    def test_reduced_motion_makes_every_open_and_close_instant(self):
        for sel in (".ws-pop", ".ws-dialog", ".ws-navtab-icon", ".ws-sheet-scrim"):
            self.assertTrue(stilled(THEME, sel, "transition"), sel)
        self.assertTrue(stilled(THEME, ".ws-dialog > .ws-dialog-box", "animation"))

    def test_no_new_intervals(self):
        # WS.poll owns the one interval in shell.js; the touches add none.
        self.assertEqual(js_code_only(SHELL_JS).count("setInterval("), 1)
        self.assertNotIn("setInterval", js_code_only(UI_JS))


class NavHighlight(unittest.TestCase):
    """The active nav item switches instantly, as it always did: the sliding
    highlight was removed at the owner's request (it read as the old page's
    button moving into the new one's place, and felt laggy). Only the shell
    itself carries a transition name, which keeps it stationary through the
    router's soft swap."""

    # The shell's names are scoped to html.ws-vt, which is on only while a
    # transition runs (ShellNamesOnlyDuringATransition below).
    SHELL_NAMES = {"html.ws-vt #desktopSidebar": "ws-sidebar", "html.ws-vt #appHeader": "ws-header",
                   "html.ws-vt #mobileTopBar": "ws-topbar", "html.ws-vt main": "ws-content",
                   "html.ws-vt #wsPlayer": "ws-player"}

    def test_only_the_shell_carries_a_transition_name(self):
        named = {sel.strip(): name for sel, name in
                 re.findall(r"([^{}]+)\{\s*view-transition-name:\s*([\w-]+);\s*\}", top_level(THEME))}
        self.assertEqual(named, self.SHELL_NAMES)

    def test_no_nav_item_carries_a_transition_name(self):
        css = re.sub(r"/\*.*?\*/", "", THEME, flags=re.S)
        self.assertNotRegex(css, r"(?i)nav[^{}]*\{[^}]*view-transition-name")
        self.assertNotIn("ws-nav-active", THEME)
        for markup in (SIDEBAR, HEADER, SHELL_JS):
            self.assertNotIn("view-transition", markup)
            self.assertNotIn("viewTransition", markup)

    def test_the_shell_stays_stationary_across_pages(self):
        self.assertIn("view-transition-name: ws-sidebar", css_rule(THEME, "html.ws-vt #desktopSidebar"))
        # The old snapshot of each stationary part is dropped and the new one
        # does not animate: only the content crossfades.
        self.assertRegex(THEME, r"::view-transition-old\(ws-sidebar\)[^{}]*\{\s*display: none;")
        # The player too: unnamed it was part of the root snapshot, which
        # paints under <main>'s, so a visible player blinked on every swap
        # (final review M7). It stays still like the rest of the shell.
        for sel in ("::view-transition-old(ws-player)", "::view-transition-new(ws-player)"):
            self.assertIn(sel, THEME)
        self.assertRegex(THEME, r"::view-transition-old\([^{}]*ws-player\)[^{}]*\{\s*display: none;")
        self.assertRegex(THEME, r"::view-transition-new\([^{}]*ws-player\)[^{}]*\{\s*animation: none;")

    def test_no_cross_document_transition(self):
        # Every shell page is a soft-navigation page; a full navigation (sign
        # in, setup, a fallback) opts into no transition, under any motion
        # setting. The soft swap's own reduced-motion guard is router.js's
        # (ShellNamesOnlyDuringATransition below).
        self.assertNotIn("@view-transition", THEME)


class ShellNamesOnlyDuringATransition(unittest.TestCase):
    """A view-transition-name makes its element a stacking context. Left on
    <main>, it put every position:fixed page overlay (the Issues and Tickets
    modals) under the phone's sticky top bar. So the sidebar, header, mobile
    bar and <main> are named only under html.ws-vt, which router.js holds
    (through theme-loader.js's WSViewTransition) for the length of a soft
    swap's transition. app/tests/js/view_transition.mjs runs the hold/release."""

    SHELL_PARTS = ("#desktopSidebar", "#appHeader", "#mobileTopBar", "main", "#wsPlayer")
    LOADER = (STATIC / "js" / "theme-loader.js").read_text(encoding="utf-8")
    ROUTER = (STATIC / "js" / "router.js").read_text(encoding="utf-8")

    def test_no_shell_part_is_named_outside_a_transition(self):
        css = re.sub(r"/\*.*?\*/", "", THEME, flags=re.S)
        named = [sel.strip() for sel, _ in
                 re.findall(r"([^{}]+)\{([^{}]*view-transition-name[^{}]*)\}", css)]
        for sel in named:
            for one in (s.strip() for s in sel.split(",")):
                # The element the rule names: its last compound, minus any
                # pseudo-class or attribute on it.
                target = re.split(r"[:\[]", one.split()[-1])[0]
                if target in self.SHELL_PARTS:
                    self.assertTrue(one.startswith("html.ws-vt "), f"{one} is named at rest")
        for part in self.SHELL_PARTS:
            self.assertIn(f"html.ws-vt {part}", named, part)

    def test_no_page_names_a_shell_part_itself(self):
        for f in list(STATIC.glob("*.html")) + list((STATIC / "partials").glob("*.html")):
            text = f.read_text(encoding="utf-8")
            with self.subTest(f.name):
                self.assertIsNone(re.search(r"view-transition-name:(?!\s*none\b)", text), f.name)
                self.assertIsNone(re.search(r'<html[^>]*class="[^"]*\bws-vt\b', text), f.name)

    def test_login_main_is_never_named(self):
        # A named <main> is a backdrop root: the card's blur would stop
        # reaching the artwork behind it. Login has no router, so nothing ever
        # holds html.ws-vt there, and no rule of its own names anything.
        self.assertNotIn("router.js", LOGIN)
        self.assertNotIn("view-transition", LOGIN)

    def test_every_page_loads_the_holder_in_head(self):
        # theme-loader.js (WSViewTransition, and the colours before the first
        # paint) is a parser-blocking script in <head> on every page.
        for f in STATIC.glob("*.html"):
            text = f.read_text(encoding="utf-8")
            with self.subTest(f.name):
                head = text.split("</head>", 1)[0]
                self.assertRegex(head, r'<script src="/static/js/theme-loader\.js\?v=\d+"></script>')

    def test_only_the_router_holds_the_names(self):
        # No cross-document transition, so no pageswap/pagereveal hold.
        for event in ("pageswap", "pagereveal"):
            self.assertFalse(live_matches(self.LOADER, rf"addEventListener\('{event}'"), event)
        self.assertTrue(live_matches(self.LOADER, r"window\.WSViewTransition = \{ hold: hold \}"))

    def test_a_soft_swap_holds_from_before_the_capture_until_it_settles(self):
        code = js_code_only(self.ROUTER)
        start = code.index("async function inTransition(")
        body = code[start:matching_brace(code, code.index("{", start))]
        hold = body.index("WSViewTransition.hold()")
        begin = body.index("document.startViewTransition(update)")
        self.assertLess(hold, begin, "the names must be on before the old state is captured")
        self.assertIn("t.finished.then(release, release)", body)
        catch = body.index("catch (e)")
        self.assertIn("release();", body[catch:body.index("t.ready")])
        # The reduced-motion and no-API path runs before any hold.
        self.assertLess(body.index("reduceMotion()"), hold)


class HoverLift(unittest.TestCase):
    def test_lift_moves_transform_and_shadow_only_and_hovers_only_for_a_pointer(self):
        # The pointer-only block that holds the lift (others, the phone tab
        # bar's, come earlier in the file).
        hover = next((m for m in re.finditer(r"@media \(hover: hover\) and \(pointer: fine\)\s*\{(.*?)\n\}", THEME, re.S)
                      if ".ws-lift:hover" in m.group(1)), None)
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
        # A book's detail has its one Request button (both formats), which lifts too.
        index = (STATIC / "index.html").read_text(encoding="utf-8") + \
            (STATIC / "js" / "pages" / "home.js").read_text(encoding="utf-8")   # its cards
        news = (STATIC / "news.html").read_text(encoding="utf-8") + \
            (STATIC / "js" / "pages" / "news.js").read_text(encoding="utf-8")   # its cards
        requests = (STATIC / "requests.html").read_text(encoding="utf-8") + \
            (STATIC / "js" / "pages" / "requests.js").read_text(encoding="utf-8")   # its cards
        self.assertNotIn("ws-lift", index)
        self.assertNotIn("ws-lift", news)
        self.assertEqual(len(re.findall(r'class="[^"]*\bws-lift\b', requests)), 4)   # in markup, not in comments
        self.assertIn('<button type="button" class="shrink-0 w-32 text-left rounded-inner ws-lift group"', requests)  # discover poster
        self.assertRegex(requests, r'data-request-title="[^"]*" class="ws-lift w-full')       # search card button
        self.assertIn("'class=\"ws-lift w-full py-2.5 rounded-btn bg-primary", requests)     # the detail's Request button
        self.assertIn("'class=\"ws-lift w-full py-2 px-1 rounded-btn border border-transparent bg-primary", requests)  # a book's
        self.assertNotRegex(requests, r'<div class="[^"]*\bws-lift')                           # no inert card
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
        m = live_matches(LOGIN_JS, r"function restartDrift\(slide\) \{")
        self.assertTrue(m, "restartDrift")
        body = LOGIN_JS[m[0].end():matching_brace(LOGIN_JS, m[0].end() - 1)]
        off = live_matches(body, r"slide\.classList\.remove\('is-moving'")
        reflow = live_matches(body, r"void slide\.offsetWidth;")
        on = live_matches(body, r"slide\.classList\.add\('is-moving', DRIFTS\[lastDrift\]\)")
        self.assertTrue(off and reflow and on)
        self.assertLess(off[0].start(), reflow[0].start())
        self.assertLess(reflow[0].start(), on[0].start())
        # The next direction always differs from the last one.
        self.assertTrue(live_matches(
            body, r"lastDrift = \(lastDrift \+ 1 \+ Math\.floor\(Math\.random\(\) \* \(DRIFTS\.length - 1\)\)\) % DRIFTS\.length;"))
        self.assertTrue(live_matches(LOGIN_JS, r"var DRIFTS = \['drift-nw', 'drift-ne', 'drift-sw', 'drift-se'\];"))
        # show(): the incoming slide restarts before its opacity goes to 1;
        # the outgoing slide's classes are left alone.
        m = live_matches(LOGIN_JS, r"function show\(next, prev, url\) \{")
        self.assertTrue(m, "show")
        body = LOGIN_JS[m[0].end():matching_brace(LOGIN_JS, m[0].end() - 1)]
        restart = live_matches(body, r"restartDrift\(next\);")
        fade_in = live_matches(body, r"next\.style\.opacity = '1';")
        self.assertTrue(restart and fade_in)
        self.assertLess(restart[0].start(), fade_in[0].start())
        self.assertTrue(live_matches(body, r"prev\.style\.opacity = '0';"))
        self.assertFalse(re.search(r"prev\.classList", body))
        # The first picture starts once the slideshow is shown, before it
        # fades in; a lone picture takes the back-and-forth drift instead.
        reveal = live_matches(LOGIN_JS, r"slideshow\.classList\.remove\('hidden'\);")
        first = live_matches(LOGIN_JS, r"if \(urls\.length < 2\) slideA\.classList\.add\('is-solo'\); else restartDrift\(slideA\);")
        shown = live_matches(LOGIN_JS, r"slideA\.style\.opacity = '1';")
        self.assertTrue(reveal and first and shown)
        self.assertLess(reveal[0].start(), first[0].start())
        self.assertLess(first[0].start(), shown[0].start())

    def test_rotation_is_single_flight_and_never_crossfades_a_picture_onto_itself(self):
        # One preload at a time: a tick during a pending preload does nothing
        # (no index advance, no second request), so a slow network only slows
        # the rotation and can never starve it, and a resolved preload is the
        # newest by construction, so it is always shown. A failed one releases
        # the flight. A candidate already on screen is skipped. (A sequence
        # counter that dropped a preload once a newer tick had merely started
        # starved the rotation whenever every load took over 10s.)
        m = live_matches(LOGIN_JS, r"setInterval\(async function\(\) \{")
        self.assertEqual(len(m), 1)
        body = LOGIN_JS[m[0].end():matching_brace(LOGIN_JS, m[0].end() - 1)]
        steps = [
            ("gate", r"if \(urls\.length < 2 \|\| loading\) return;"),
            ("advance", r"currentIndex\+\+;"),
            ("same picture", r"if \(nextUrl === shownUrl\) return;"),
            ("take", r"loading = true;"),
            ("wait", r"await preload\(nextUrl\);"),
            ("release", r"\} finally \{\s*loading = false;\s*\}"),
            ("remember", r"shownUrl = nextUrl;"),
            ("show", r"show\(slideB, slideA, nextUrl\);"),
        ]
        found = {}
        for name, pattern in steps:
            hits = live_matches(body, pattern)
            self.assertEqual(len(hits), 1, name)
            found[name] = hits[0]
        starts = [found[name].start() for name, _ in steps]
        self.assertEqual(starts, sorted(starts), "the steps run in this order")
        # The flag is the only gate: once the preload resolves nothing turns
        # the picture away, and no sequence counter exists to drop it.
        between = js_code_only(body[found["release"].end():found["show"].start()])
        self.assertNotRegex(between, r"\breturn\b")
        self.assertNotRegex(js_code_only(LOGIN_JS), r"\b(?:seq|rotation)\b")
        self.assertTrue(live_matches(LOGIN_JS, r"var shownUrl = firstUrl;"))
        self.assertTrue(live_matches(LOGIN_JS, r"var loading = false;"))

    def test_no_new_timers_drive_the_move(self):
        # The rotation interval and the Plex PIN poll; the message clear, the
        # Plex retry, the form-reveal failsafe and the preload bound (pinned
        # below). Nothing animates from JS.
        code = js_code_only(LOGIN_JS)
        self.assertEqual(code.count("setInterval("), 2)
        self.assertEqual(code.count("setTimeout("), 4)
        self.assertNotIn("requestAnimationFrame", code)
        self.assertNotIn(".animate(", code)

    def test_a_preload_that_never_settles_releases_the_flight_after_30s(self):
        # An image request that fires neither onload nor onerror would hold
        # the single flight for the rest of the page, so each preload is
        # bounded: one timer inside preload, cleared on either outcome, that
        # drops the handlers and rejects, so the usual catch/finally releases
        # the flight. 30s, because loads of 11-25s still deserve to show.
        m = live_matches(LOGIN_JS, r"function preload\(url\) \{")
        self.assertEqual(len(m), 1)
        end = matching_brace(LOGIN_JS, m[0].end() - 1)
        body = LOGIN_JS[m[0].end():end]
        armed = live_matches(body, r"var timer = setTimeout\(function\(\) \{\s*img\.onload = img\.onerror = null;\s*reject\(\);\s*\}, 30000\);")
        self.assertEqual(len(armed), 1)
        self.assertTrue(live_matches(body, r"img\.onload = function\(\) \{ clearTimeout\(timer\); resolve\(url\); \};"))
        self.assertTrue(live_matches(body, r"img\.onerror = function\(\) \{ clearTimeout\(timer\); reject\(\); \};"))
        self.assertLess(armed[0].start(), live_matches(body, r"img\.src = url;")[0].start())
        # It is the only timer beyond the ones the page always had.
        self.assertEqual(js_code_only(LOGIN_JS[:m[0].start()] + LOGIN_JS[end:]).count("setTimeout("), 3)

    def test_the_card_glass_and_the_form_reveal_are_untouched(self):
        glass = css_rule(LOGIN, ".login-glass-card")
        # The glass is the site's frost tokens (test_frost.py pins their values).
        self.assertIn("background: var(--ws-frost-tint)", glass)
        self.assertIn("backdrop-filter: var(--ws-frost-blur)", glass)
        self.assertIn("#loginForm { visibility: hidden; }", LOGIN)
        self.assertIn("#loginForm.auth-ready { visibility: visible; }", LOGIN)


if __name__ == "__main__":
    unittest.main()
