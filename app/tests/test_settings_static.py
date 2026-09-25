"""
Static contract for the Settings frame, the shared UI helpers and the tab
modules: every tab has a link, a panel and a module; nothing uses a colour
outside the theme engine, a native dialog, or text under 12px.
"""
import re
import unittest
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "static"
FRAME = "settings-next.html"     # renamed to settings.html in Task 8.1
TABS = ["general", "pages", "appearance", "sign-in", "integrations", "notifications"]
MODULES = {"general": "general.js", "pages": "pages.js", "appearance": "appearance.js",
           "sign-in": "signin.js", "integrations": "integrations.js", "notifications": "notifications.js"}
# Text colour from outside the theme engine: a Tailwind palette class, an
# arbitrary text-[#hex] / text-[rgb(...)] / text-[hsl(...)], or an inline
# color: #... / rgb(...) / hsl(...) in markup or a JS string. rgb(var(--...))
# is the theme engine itself and stays allowed; background-color and
# border-color are not text.
PALETTE_TEXT = re.compile(
    r"\btext-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|"
    r"teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b"
    r"|\btext-\[(?:#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()"
    r"|(?<![\w-])color\s*:\s*(?:#[0-9a-fA-F]{3,8}\b|rgba?\((?!\s*var\()|hsla?\()"
    r"|\.style\.color\s*=\s*['\"](?:#|rgba?\((?!\s*var\()|hsla?\()")
NATIVE_DIALOG = re.compile(r"(?<![\w.])(?<!function )(?:confirm|alert|prompt)\(|window\.(?:confirm|alert|prompt)\(")
# Text under the 12px / 0.75rem floor, as an arbitrary Tailwind size or an
# inline font-size (markup or JS). A fraction of a rem/em is under the floor
# when it is below .75: .0-.6x, or .7 followed by nothing or 0-4.
_UNDER_075 = r"(?<![\d.])0?\.(?:[0-6]\d*|7(?:[0-4]\d*)?)(?:r?em)\b"
TINY_TEXT = re.compile(
    r"text-\[(?:(?:\d|1[01])(?:\.\d+)?px|" + _UNDER_075 + r")\]"
    r"|(?:font-size\s*:|fontSize\s*=)\s*['\"]?\s*(?:(?:\d|1[01])(?:\.\d+)?px\b|" + _UNDER_075 + r")")

from app.tests.test_shell_contract import js_code_only, live_matches, matching_brace

try:
    from fastapi.testclient import TestClient  # noqa: F401
    from app.tests.test_page_gating import ADMIN_SESSION, MEMBER_SESSION, PageRoutesBase
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False
    PageRoutesBase = unittest.TestCase


# The shared shell scripts every page loads; the shell contract guards them.
# Everything else the frame loads is a Settings file and is scanned below.
SHELL_JS = {"js/theme-loader.js", "js/auth.js", "js/shell.js", "js/notifications.js"}

# Files the frame references that later tasks write. Each task deleted its own
# entries when it added the file (a file here that exists fails the test);
# Task 6.5 removed the last one, and Task 8.4 asserts the set stays empty.
PENDING: set = set()


def referenced_js():
    """Every /static/js/... file the frame loads, the template modules included,
    less the shared shell scripts."""
    h = (STATIC / FRAME).read_text(encoding="utf-8")
    return sorted(set(re.findall(r'\bsrc="/static/(js/[^"?]+\.js)[?"]', h)) - SHELL_JS)


def kit_code() -> str:
    """kit.js with comments removed and string contents blanked, so a pin is
    only met by live code (a comment naming the fix does not count)."""
    return js_code_only((STATIC / "js" / "settings" / "kit.js").read_text(encoding="utf-8"))


def function_body(code: str, name: str) -> str:
    """The body of `function name(...) { ... }` in comment-free code."""
    m = re.search(rf"\bfunction {name}\([^)]*\)\s*\{{", code)
    assert m, f"function {name} not found"
    return code[m.end():matching_brace(code, m.end() - 1)]


def top_level(code: str) -> str:
    """code with the contents of every nested {...} removed, so what is left is
    only the statements that run unconditionally at this level."""
    out, depth = [], 0
    for ch in code:
        if ch == "}":
            depth -= 1
        if depth == 0:
            out.append(ch)
        if ch == "{":
            depth += 1
    return "".join(out)


def settings_files():
    """The frame, every Settings script it references that exists, and every
    js/settings/*.js file. A referenced file may only be missing while it is
    in PENDING (checked by Hygiene.test_referenced_files_exist_or_are_pending)."""
    files = {STATIC / FRAME}
    files.update(STATIC / rel for rel in referenced_js() if (STATIC / rel).exists())
    files.update((STATIC / "js" / "settings").glob("*.js"))
    return sorted(files)


class Frame(unittest.TestCase):
    def test_every_tab_has_a_link_a_panel_and_a_module(self):
        h = (STATIC / FRAME).read_text(encoding="utf-8")
        for t in TABS:
            self.assertRegex(h, rf'<a[^>]*href="#{t}"[^>]*data-tab="{t}"', t)
            self.assertIn(f'data-settings-panel="{t}"', h)
            self.assertIn(f'<script data-tab="{t}" src="/static/js/settings/{MODULES[t]}?v=1"></script>', h)
        self.assertIn('id="settingsSaveBar"', h)
        self.assertIn('id="settingsModules"', h)
        self.assertLess(h.index("/static/js/ui.js?v="), h.index("/static/js/settings/kit.js?v="))
        self.assertLess(h.index("/static/js/auth.js?v="), h.index("/static/js/settings/kit.js?v="))

    def test_first_paint_selects_the_tab_from_the_hash(self):
        h = (STATIC / FRAME).read_text(encoding="utf-8")
        self.assertIn("data-settings-tab", h)
        # Set in <head>, so nothing in the body - the tab strip included -
        # paints before the tab is known.
        head = h[:h.index("</head>")]
        self.assertRegex(head, r"document\.documentElement\.setAttribute\(\s*'data-settings-tab'")
        css = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        for t in TABS:
            self.assertIn(f'html[data-settings-tab="{t}"] [data-settings-panel="{t}"]', css)
            # The selected tab's look comes from the same attribute.
            self.assertIn(f'html[data-settings-tab="{t}"] #tab-{t}', css)
        for token in ("--ws-status-ok", "--ws-status-warn", "--ws-status-err", "--ws-status-off", ".ws-light-ok",
                      ".ws-light-warn", ".ws-light-error", ".ws-light-unconfigured", ".ws-invalid",
                      ".ws-switch", ".ws-tab", ".ws-savebar", ".ws-admin-only"):
            self.assertIn(token, css)

    def test_not_set_up_light_uses_the_off_token(self):
        # R16 / R79 (c): G7's --ws-status-off is the accent. Integrations'
        # "not set up" light is its own class drawn from it (an empty ring, so
        # it can't pass for a live status whatever the accent is), while
        # .ws-light-unconfigured - also the info toast's tone - stays the
        # filled neutral dot it always was.
        css = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        root = re.search(r":root \{([^}]*--ws-status-ok[^}]*)\}", css)
        self.assertIsNotNone(root)
        self.assertRegex(root.group(1), r"--ws-status-off:\s*var\(--color-accent\);")
        off = re.findall(r"\.ws-light-off \{([^}]*)\}", css)
        self.assertEqual(len(off), 1, "one .ws-light-off rule")
        self.assertIn("var(--ws-status-off)", off[0])
        self.assertRegex(off[0], r"background:\s*transparent")
        unconf = re.findall(r"\.ws-light-unconfigured \{([^}]*)\}", css)
        self.assertEqual(unconf, [" background: rgb(var(--color-text) / .25); "], "the toast tone stays a filled dot")
        # Nothing else restyles it (a second selector list naming it).
        self.assertEqual(len(re.findall(r"\.ws-light-unconfigured\b", css)), 1)
        ui = (STATIC / "js" / "ui.js").read_text(encoding="utf-8")
        self.assertTrue(live_matches(ui, r"info: 'ws-light-unconfigured'"), "the info toast's tone moved")
        src = (STATIC / "js" / "settings" / "integrations.js").read_text(encoding="utf-8")
        self.assertTrue(live_matches(src, r"\bunconfigured: 'ws-light-off'"))

    def test_tab_scroll_hints_fade_the_strip_edge(self):
        # On a phone the arrows sit over the strip; each carries an edge fade
        # from the page background so it never lies on top of tab text.
        h = (STATIC / FRAME).read_text(encoding="utf-8")
        for side in ("Left", "Right"):
            m = re.search(rf'<div id="settingsTabHint{side}" class="([^"]*)"', h)
            self.assertIsNotNone(m, side)
            self.assertIn(f"ws-tab-hint-{side.lower()}", m.group(1).split(), side)
        css = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        for side in ("left", "right"):
            rule = re.search(rf"\.ws-tab-hint-{side}\s*\{{([^}}]*)\}}", css)
            self.assertIsNotNone(rule, side)
            self.assertIn("linear-gradient(", rule.group(1), side)
            self.assertIn("rgb(var(--color-background)", rule.group(1), side)

    def test_tab_hints_start_hidden(self):
        # Neither arrow paints before the strip is known to overflow; the
        # first-paint script or the kit reveals it.
        h = (STATIC / FRAME).read_text(encoding="utf-8")
        for side in ("Left", "Right"):
            self.assertRegex(h, rf'<div id="settingsTabHint{side}"[^>]*style="[^"]*\bopacity:\s*0(?![.\d])\s*;?[^"]*"', side)

    def test_reduced_motion_stills_the_tab_hints(self):
        # The hints fade with transition-opacity; reduced motion switches that off.
        css = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        blocks = re.findall(r"@media \(prefers-reduced-motion: reduce\) \{(.*?)\n\}", css, re.S)
        still = [b for b in blocks if ".ws-savebar" in b]
        self.assertTrue(still, "the Settings reduced-motion block is missing")
        for side in ("left", "right"):
            self.assertRegex(still[0], rf"\.ws-tab-hint-{side}\b[^{{}}]*\{{[^}}]*transition:\s*none", side)


class Hygiene(unittest.TestCase):
    def test_referenced_files_exist_or_are_pending(self):
        refs = referenced_js()
        self.assertIn("js/ui.js", refs)
        self.assertIn("js/settings/kit.js", refs)
        for rel in refs:
            exists = (STATIC / rel).exists()
            if rel in PENDING:
                self.assertFalse(exists, f"{rel} exists now: remove it from PENDING")
            else:
                self.assertTrue(exists, f"{rel} is loaded by the frame but missing")
        self.assertEqual(sorted(PENDING - set(refs)), [], "PENDING lists files the frame does not load")

    def test_theme_colours_only_no_native_dialogs_no_tiny_text(self):
        for f in settings_files():
            text = f.read_text(encoding="utf-8")
            self.assertIsNone(PALETTE_TEXT.search(text), f"{f.name}: palette colour on text")
            self.assertIsNone(NATIVE_DIALOG.search(text), f"{f.name}: native dialog")
            self.assertIsNone(TINY_TEXT.search(text), f"{f.name}: text under 12px")

    def test_no_default_tables_in_the_front_end(self):
        for f in settings_files():
            text = f.read_text(encoding="utf-8")
            # Font names are legitimate choices in the Appearance font list, so the
            # default font is not checked here; colours, tagline and icon defaults are.
            for leaked in ("#125793", "#2C6DA1", "#4684B0", "#BEEEF4", "#E9D5FF", "#67E8F9", "#FCD34D",
                           "Media Server Management", "health_metrics", "confirmation_number",
                           "settings_input_component", "***masked***"):
                self.assertNotIn(leaked, text, f"{f.name} carries a default ({leaked}); read it from meta")


class KitApi(unittest.TestCase):
    def test_ui_js_public_api(self):
        js = (STATIC / "js" / "ui.js").read_text(encoding="utf-8")
        for name in ("el", "icon", "toast", "confirm", "cls"):
            self.assertRegex(js, rf"\b{name}: {name}\b", name)

    def test_kit_public_api(self):
        js = (STATIC / "js" / "settings" / "kit.js").read_text(encoding="utf-8")
        for name in ("boot", "registerTab", "go", "metaFor", "card", "leave", "view"):
            self.assertRegex(js, rf"\b{name}: {name}\b", name)
        for method in ("text", "textarea", "toggle", "select", "color", "iconPicker", "secret", "track",
                       "get", "set", "stageDefaults", "onChange", "onSaved", "onDiscard", "beforeSave",
                       "fieldError", "dirtyKeys", "save", "saved"):
            self.assertIn(f"api.{method} = function", js, method)
        for event in ("ws-settings:saved", "ws-settings:discarded", "ws-settings:tab"):
            self.assertIn(event, js)
        self.assertIn("beforeunload", js)
        self.assertIn("/api/admin/settings?view=registry", js)
        self.assertIn("/api/admin/settings/bulk", js)

    def test_kit_patches_the_sidebar_after_nav_saves(self):
        src = (STATIC / "js" / "settings" / "kit.js").read_text(encoding="utf-8")
        for literal in ("'/api/admin/settings/shell'", "'desktopNav'", "'drawerNav'"):
            self.assertTrue(live_matches(src, re.escape(literal)), literal)
        # The keys that change the sidebar, exactly (Task 5.2 / R69 d). The
        # declaration must be live code (a copy in a comment does not count);
        # js_code_only blanks a regex literal's body, so the live declaration
        # is found first and the literal read from the source right after it.
        decls = live_matches(src, r"\bvar NAV_KEYS = (?=/)")
        self.assertEqual(len(decls), 1, "one live NAV_KEYS declaration")
        self.assertTrue(src.startswith(r"/^(sidebar\.|icon\.nav_|pages\.order$|integration\.kavita\.url$)/;",
                                       decls[0].end()), "NAV_KEYS is the ruled pattern")
        self.assertRegex(function_body(kit_code(), "refreshShell"),
                         r"if \(keys\.some\(function \((\w+)\) \{ return NAV_KEYS\.test\(\1\); \}\)\) patchShell\(\);")

    def test_sidebar_patch_uses_diff_writes_and_rewires_the_links(self):
        # The fragment goes in through WS.setHTML only (the one HTML string the
        # kit inserts, server-rendered and escaped), and the shell re-binds its
        # per-link behaviour (hover prefetch) on the new links afterwards.
        body = function_body(kit_code(), "patchShell")
        self.assertNotRegex(body, r"innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment")
        write = re.search(r"\bWS\.setHTML\(document\.getElementById\((\w+)\), data\.nav_html\)", body)
        self.assertIsNotNone(write, "the navs are written with WS.setHTML")
        rewire = re.search(r"\bWS\.wireNav\(\)", body)
        self.assertIsNotNone(rewire, "WS.wireNav() after the patch")
        self.assertGreater(rewire.start(), write.end(), "wireNav runs after the links are replaced")
        # A failed fetch is quiet: no toast, the save already succeeded.
        self.assertNotIn("toast", body)

    def test_every_save_drops_prefetched_pages(self):
        # Pages the service worker prefetched before a save carry the old nav,
        # theme or name. Every save that wrote a key clears them, not only a
        # nav save: refreshShell runs unconditionally in applySaved's
        # "something was written" block, and its clearPageCache call does not
        # depend on which keys they were.
        code = kit_code()
        body = function_body(code, "applySaved")
        m = re.search(r"\bif \(keys\.length\) \{", body)
        self.assertIsNotNone(m)
        block = top_level(body[m.end():matching_brace(body, m.end() - 1)])
        self.assertRegex(block, r"(?:^|[;{}])\s*refreshShell\(keys\);")
        # A statement of its own (only its own existence check as a
        # condition), with no early return ahead of it but the WS guard.
        rs = top_level(function_body(code, "refreshShell"))
        call = re.search(r"(?:^|[;{}])\s*(?P<stmt>(?:if \(WS\.clearPageCache\) )?WS\.clearPageCache\(\);)", rs)
        self.assertIsNotNone(call, "an unconditional WS.clearPageCache() in refreshShell")
        before = rs[:call.start("stmt")].replace("if (!WS) return;", "")
        self.assertNotRegex(before, r"\breturn\b")

    def test_import_drops_prefetched_pages_before_reloading(self):
        # An import writes settings like a save does: pages prefetched or
        # prerendered before it hold the old nav, theme or name. The clear runs
        # as soon as the import is confirmed applied, not inside the delayed
        # reload (which a navigation could beat).
        code = js_code_only((STATIC / "js" / "settings" / "general.js").read_text(encoding="utf-8"))
        m = re.search(r"\bif \(applied\.status === 200 && applied\.data && Array\.isArray\(applied\.data\.applied\)\) \{", code)
        self.assertIsNotNone(m, "the import's success branch")
        block = top_level(code[m.end():matching_brace(code, m.end() - 1)])
        clear = re.search(r"(?:^|[;{}])\s*(?P<stmt>(?:if \(window\.WS && WS\.clearPageCache\) )?WS\.clearPageCache\(\);)", block)
        self.assertIsNotNone(clear, "an unconditional WS.clearPageCache() in the success branch")
        reload = re.search(r"(?:^|[;{}])\s*setTimeout\(function \(\) \{\}", block)
        self.assertIsNotNone(reload, "the delayed reload")
        self.assertLess(clear.start("stmt"), reload.start(), "cleared before the reload is scheduled")

    def test_saved_is_the_baseline(self):
        # R79 (a): api.saved(key) is the last-saved value (what Discard returns
        # to), never a staged one: the kit's own baseline(), as live code.
        src = (STATIC / "js" / "settings" / "kit.js").read_text(encoding="utf-8")
        found = live_matches(src, r"\bapi\.saved = function \((\w+)\) \{ return baseline\(\1\); \};")
        self.assertEqual(len(found), 1, "api.saved returns baseline(key)")
        # Inside makeApi, where the other controls are.
        api = function_body(kit_code(), "makeApi")
        self.assertRegex(api, r"\bapi\.saved = function \((\w+)\) \{ return baseline\(\1\); \};")

    def test_secret_inputs_carry_password_manager_hints(self):
        # R66 / R79 (f): an API key is not a password. Beside
        # autocomplete="new-password", the secret input tells 1Password,
        # LastPass, Bitwarden and Dashlane-style managers to leave it alone.
        src = (STATIC / "js" / "settings" / "kit.js").read_text(encoding="utf-8")
        start, end = src.index("api.secret = function"), src.index("return api;")
        body = src[start:end]
        self.assertTrue(live_matches(body, r"\binput\.type = 'password';"))
        self.assertTrue(live_matches(body, r"\binput\.autocomplete = 'new-password';"))
        for name, value in (("data-1p-ignore", ""), ("data-lpignore", "true"), ("data-bwignore", ""),
                            ("data-form-type", "other")):
            self.assertEqual(len(live_matches(body, rf"\binput\.setAttribute\('{name}', '{value}'\);")), 1, name)

    def test_mask_comes_from_the_server(self):
        # One copy of the sentinel: the SettingsView payload. The kit re-exports
        # it as WSSettings.MASK; the leak test keeps any literal copy out.
        js = (STATIC / "js" / "settings" / "kit.js").read_text(encoding="utf-8")
        self.assertIn("data.mask", js)
        self.assertRegex(js, r"defineProperty\(WSSettings, 'MASK'")

    def test_tab_state_follows_every_switch(self):
        # The selected look is CSS on html[data-settings-tab]; the kit keeps it,
        # aria-selected and the URL in step for clicks, keys, hash and history.
        js = (STATIC / "js" / "settings" / "kit.js").read_text(encoding="utf-8")
        self.assertRegex(js, r"documentElement\.setAttribute\('data-settings-tab'")
        self.assertIn("aria-selected", js)
        self.assertIn("'hashchange'", js)
        self.assertIn("'popstate'", js)
        for hint in ("settingsTabHintLeft", "settingsTabHintRight"):
            self.assertIn(hint, js)

    def test_dialogs_stack_and_only_the_top_one_listens(self):
        # Two open dialogs (the icon picker, then the leave guard from Back)
        # must not fight over focus: one keydown/focusin handler, and it acts
        # for the topmost dialog only.
        js = (STATIC / "js" / "ui.js").read_text(encoding="utf-8")
        self.assertIn("function topDialog()", js)
        for handler in ("onKey", "onFocusIn"):
            m = re.search(rf"\n  function {handler}\(e\) \{{(.*?)\n  \}}", js, re.S)
            self.assertIsNotNone(m, f"{handler} is not a module-level handler")
            self.assertIn("topDialog()", m.group(1), handler)

    def test_tab_switch_dialog_always_releases(self):
        # A dialog that fails must not leave S.asking set and block every
        # later tab switch: the reset sits after a catch, so it runs every time.
        self.assertRegex(kit_code(), r"S\.asking = true;[\s\S]*?\.catch\([\s\S]*?\}\)\s*\.then\(function \(ok\) \{\s*S\.asking = false")

    def test_a_held_history_step_restores_the_url(self):
        # Back pressed while the tab-switch dialog is open is held, like the
        # other refusals in show(): the address bar goes back to the tab shown.
        self.assertRegex(kit_code(), r"if\s*\(S\.asking\)\s*\{[^{}]*\bhow\s*===[^{}]*setHash\(\s*from\b")

    def test_select_keeps_an_unknown_stored_value(self):
        # A stored value outside the options stays selected (a hidden,
        # disabled option) instead of the box showing blank and the first
        # click staging option 0.
        js = kit_code()
        body = js[js.index("api.select = function"):js.index("api.color = function")]
        self.assertIn(".disabled = true", body)
        self.assertIn(".hidden = true", body)

    def test_secret_refuses_the_mask_text(self):
        # Typing the mask itself would read as "unchanged"; it is refused with
        # an inline error, and a save the server silently skipped is never "Saved".
        js = kit_code()
        body = js[js.index("api.secret = function"):js.index("return api;")]
        handler = re.search(r"\binput\.addEventListener\(", body)
        self.assertIsNotNone(handler, "the secret input's handler")
        self.assertIn("=== S.mask", body[handler.start():])
        self.assertIn("MSG.maskText", body)
        self.assertRegex(js, r"function applySaved[\s\S]*?!hasOwn\(values, k\)[\s\S]*?function applyErrors")

    def test_modules_register_their_tab(self):
        for tab, module in MODULES.items():
            path = STATIC / "js" / "settings" / module
            if path.exists():
                self.assertIn(f"WSSettings.registerTab('{tab}'", path.read_text(encoding="utf-8"), module)


def general_function(name: str) -> str:
    """One top-level function of general.js as live code (comments removed,
    strings blanked): from its `function name(` to the next top-level
    function or the tab registration."""
    js = js_code_only((STATIC / "js" / "settings" / "general.js").read_text(encoding="utf-8"))
    m = re.search(rf"\n  function {name}\(.*?(?=\n  function |\n  WSSettings\.registerTab)", js, re.S)
    if m is None:
        raise AssertionError(f"general.js has no top-level function {name}()")
    return m.group(0)


class GeneralTab(unittest.TestCase):
    """The General tab's backup and logo rules that can be read from the code."""

    def test_import_preview_lists_the_warnings(self):
        # Unchanged values today's rules would refuse are shown as "kept as-is",
        # next to the changes, not dropped from the preview.
        start = general_function("startImport")
        self.assertRegex(start, r"\bwarnings\s*=\s*plainObject\(\s*\w+\.warnings\s*\)")
        self.assertRegex(start, r"previewBody\(\s*changes\s*,\s*ignored\s*,\s*warnings\s*\)")
        self.assertRegex(general_function("previewBody"), r"Object\.keys\(\s*warnings\s*\)\s*\.forEach\(")

    def test_a_failed_import_lists_every_error(self):
        # A 422 carries a message per key; `detail` is only the first of them.
        body = general_function("showProblems")
        self.assertRegex(body, r"\.errors\b")
        self.assertRegex(body, r"Object\.keys\([^)]*\)[\s\S]*?\.forEach\(")
        self.assertNotRegex(body, r"\.detail\b")
        # Both the preview and the apply send a 422 there.
        calls = re.findall(r"status\s*===\s*422\)\s*(?:return\s+)?showProblems\(", general_function("startImport"))
        self.assertGreaterEqual(len(calls), 2)

    def test_the_import_file_is_size_capped_and_parsed_safely(self):
        js = js_code_only((STATIC / "js" / "settings" / "general.js").read_text(encoding="utf-8"))
        self.assertRegex(js, r"\bvar MAX_IMPORT_BYTES\s*=\s*\d")
        body = general_function("startImport")
        size = re.search(r"\.size\s*>\s*MAX_IMPORT_BYTES\b", body)
        read = re.search(r"\.text\(\)", body)
        self.assertIsNotNone(size, "no size check on the import file")
        self.assertIsNotNone(read, "the import file is never read")
        self.assertLess(size.start(), read.start(), "the size is checked after the file is read")
        self.assertRegex(body, r"try\s*\{[^{}]*JSON\.parse\([^{}]*\}\s*catch\b")

    def test_no_client_check_on_the_logo_address(self):
        # R14: the server's 422 on Save is the check, shown on the field by the kit.
        body = general_function("logoCard")
        for probe in (r"\.test\(", r"\.exec\(", r"\.match\(", r"\bRegExp\b", r"\.startsWith\("):
            self.assertNotRegex(body, probe)
        # Nor a prefix check by hand in the preview code (the upload's own
        # type check further down may use indexOf).
        preview = body[body.index("function placeholder("):body.index("var seq = 0")]
        for probe in (r"[iI]ndexOf\(", r"\.slice\(", r"\.substring\(", r"\.substr\(", r"\.includes\(",
                      r"\.charAt\(", r"\.charCodeAt\(", r"\[0\]\s*===?"):
            self.assertNotRegex(preview, probe)
        # The address is a kit field, so the server's message lands on it: live
        # code (strings blanked, so a comment can't count), and the key it binds.
        self.assertRegex(body, r"api\.text\(\{\s*key:\s*' {17}'")
        src = (STATIC / "js" / "settings" / "general.js").read_text(encoding="utf-8")
        self.assertRegex(src, r"api\.text\(\{\s*key:\s*'branding\.logo_url'")

    def test_another_logo_choice_cancels_an_upload_in_flight(self):
        # A late upload answer must not overwrite "No logo", the built-in logo
        # or a typed address chosen after it started.
        body = general_function("logoCard")
        cancel = re.search(r"function cancelUpload\(\) \{([^{}]*)\}", body)
        self.assertIsNotNone(cancel, "no cancelUpload()")
        self.assertRegex(cancel.group(1), r"\bseq\s*\+=\s*1|\+\+seq\b|\bseq\+\+")
        for control, event in (("builtIn", "click"), ("noLogo", "click"), ("input", "input")):
            self.assertRegex(body, rf"\b{control}\.addEventListener\('\s{{{len(event)}}}', function \(\) \{{[^{{}}]*cancelUpload\(\)",
                             control)
        self.assertRegex(body, r"api\.onDiscard\(function \(\) \{[^{}]*cancelUpload\(\)")
        self.assertRegex(body, r"if \(mine !== seq\) return;")

    def test_import_rechecks_for_edits_before_confirm_and_apply(self):
        # An edit made while the preview loads (or the dialog is up) would be
        # thrown away by the reload after the import: check again at each step.
        guard = general_function("blockedByEdits")
        self.assertIn("dirtyKeys()", guard)
        self.assertIn("MSG.dirty", guard)
        start = general_function("startImport")
        self.assertRegex(start, r"if \(blockedByEdits\(api\)\) return;\s*return WSSettings\.confirm\(\{\s*title:")
        self.assertRegex(start, r"if \(!ok \|\| blockedByEdits\(api\)\) return;\s*return postImport\(data, false")
        # The tab's fields are locked while an import runs.
        backup = general_function("backupCard")
        self.assertRegex(backup, r"\.inert = importing\b")

    def test_no_import_while_a_logo_upload_is_in_flight(self):
        # An upload still in flight has staged nothing, so the edit checks
        # pass; its answer could then land during the reload and be lost.
        # The import waits for it (refused, never a silent cancel).
        logo = general_function("logoCard")
        self.assertRegex(logo, r"function busy\(on\) \{[^{}]*shared\.uploading = on;[^{}]*shared\.changed\(\)")
        backup = general_function("backupCard")
        self.assertRegex(backup, r"imp\.disabled = dirty \|\| shared\.uploading;")
        self.assertRegex(backup, r"shared\.changed = sync;")
        handler = backup[backup.index("file.addEventListener("):]
        guard = re.search(r"if \(shared\.uploading\) \{ WSSettings\.toast\(MSG\.uploading, '   '\); return; \}", handler)
        self.assertIsNotNone(guard, "the import doesn't refuse during an upload")
        self.assertLess(guard.start(), handler.index("startImport("))
        self.assertNotRegex(backup, r"cancelUpload\(")

    def test_leaving_goes_through_the_kit(self):
        # One way out: WSSettings.leave() sets the kit's leaving flag so its
        # beforeunload guard can't ask, then navigates (or reloads).
        kit = kit_code()
        leave = re.search(r"\n  function leave\(url\) \{(.*?)\n  \}", kit, re.S)
        self.assertIsNotNone(leave, "kit has no leave(url)")
        self.assertIn("S.leaving = true", leave.group(1))
        self.assertIn("location.reload()", leave.group(1))
        outside = kit.replace(leave.group(0), "")
        self.assertNotRegex(outside, r"location\.href\s*=(?!=)|location\.reload\(")
        general = js_code_only((STATIC / "js" / "settings" / "general.js").read_text(encoding="utf-8"))
        self.assertNotRegex(general, r"location\.href\s*=(?!=)|location\.reload\(")
        self.assertRegex(general_function("failure"), r"s === 401\) \{ WSSettings\.leave\(")
        self.assertRegex(general_function("startImport"), r"setTimeout\(function \(\) \{ WSSettings\.leave\(\); \}")

    def test_notices_have_one_button(self):
        ui = js_code_only((STATIC / "js" / "ui.js").read_text(encoding="utf-8"))
        # alert mode: no Cancel button, and Escape / the backdrop answer true.
        self.assertRegex(ui, r"if \(!opts\.alert\) row\.appendChild\(cancel\)")
        self.assertRegex(ui, r"d\.close\(d\.dismiss\)")
        self.assertRegex(ui, r"close\(entry\.dismiss\)")
        for fn in ("showProblems", "startImport"):
            body = general_function(fn)
            calls = re.findall(r"WSSettings\.confirm\(\{[^{}]*\}\)", body)
            notices = [c for c in calls if "alert: true" in c]
            self.assertTrue(notices, f"{fn} shows no one-button notice")
            for c in notices:
                self.assertNotIn("cancelLabel", c, fn)


APPEARANCE = STATIC / "js" / "settings" / "appearance.js"
# Any Tailwind palette colour on any utility, not only text: the preview card
# and the controls are made of theme colours alone.
ANY_PALETTE = re.compile(
    r"\b(?:text|bg|border|ring|outline|fill|stroke|from|via|to|shadow|divide|placeholder|caret|decoration)-"
    r"(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|"
    r"blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b")


def appearance_function(name: str, code: bool = True) -> str:
    """One top-level function of appearance.js, as live code (comments removed,
    strings blanked) or, with code=False, as written."""
    src = APPEARANCE.read_text(encoding="utf-8")
    js = js_code_only(src) if code else src
    m = re.search(rf"\n  function {name}\(.*?(?=\n  function |\n  WSSettings\.registerTab)", js, re.S)
    if m is None:
        raise AssertionError(f"appearance.js has no top-level function {name}()")
    return m.group(0)


class AppearanceTab(unittest.TestCase):
    """The Appearance tab's preview and reset rules that can be read from the code."""

    def test_font_guard_comes_from_meta(self):
        # R61: one pattern, the registry's, served in meta. No copy of it here.
        src = APPEARANCE.read_text(encoding="utf-8")
        code = js_code_only(src)
        guard = appearance_function("fontGuard")
        self.assertTrue(live_matches(appearance_function("fontGuard", code=False),
                                     r"WSSettings\.metaFor\('theme\.font'\)"), "the guard doesn't read meta")
        self.assertTrue(live_matches(appearance_function("fontGuard", code=False),
                                     r"new RegExp\('\^\(\?:' \+ \w+\.pattern \+ '\)\$'\)"), "not anchored")
        self.assertIn(".pattern", guard)
        # Every test the file runs is the guard built from meta.
        made = re.search(r"\b(\w+) = fontGuard\(\)", code)
        self.assertIsNotNone(made, "the guard is never built")
        # A regex literal is blanked to spaces, so count every .test( call,
        # whatever it is called on, against the guard's own.
        guarded = len(re.findall(rf"\b{made.group(1)}\.test\(", code))
        self.assertGreater(guarded, 0, "the font preview has no guard")
        self.assertEqual(len(re.findall(r"\.test\(", code)), guarded, "a second pattern is tested")
        self.assertNotRegex(code, r"\.(?:match|search|exec)\(")
        self.assertNotIn("A-Za-z0-9", src)
        self.assertNotRegex(code, r"\bFONT_RE\b")

    def test_discard_reverts_the_font_preview(self):
        # Discard (and a tab switch that discards) repaints each changed
        # control from its saved value; the font control's paint runs the
        # preview, which puts the page's own font back at once: the preview
        # stylesheet goes and --font-display gets its first value back.
        src = APPEARANCE.read_text(encoding="utf-8")
        code = js_code_only(src)
        self.assertRegex(kit_code(), r"function discard\(id\) \{[\s\S]*?b\.set\(baseline\(k\)\)")
        self.assertTrue(live_matches(src, r"api\.track\('theme\.font', \{"))
        track = re.search(r"api\.track\(' {10}', \{", code)
        self.assertIsNotNone(track)
        binding = code[track.end() - 1:matching_brace(code, track.end() - 1) + 1]
        setter = re.search(r"\bset:\s*(\w+)", binding)
        self.assertIsNotNone(setter, "the font binding has no set()")
        paint = re.search(rf"function {setter.group(1)}\(v\) \{{", code)
        self.assertIsNotNone(paint)
        body = code[paint.end() - 1:matching_brace(code, paint.end() - 1) + 1]
        self.assertRegex(body, r"\bpreviewFont\(v\b")

        preview = appearance_function("previewFont")
        back = re.search(r"if \(\w+ === pageFont\) \{ revertFont\(\); return; \}", preview)
        self.assertIsNotNone(back, "the page's own font doesn't revert the preview")
        self.assertLess(preview.index("clearTimeout(fontTimer)"), back.start())
        self.assertLess(back.start(), preview.index("setTimeout("), "the revert waits on the typing delay")
        # First thing after the timer is cleared: no name check stands in front of it.
        first_check = re.search(r"\.test\(|===\s*shownFont|\breturn\b", preview)
        self.assertGreaterEqual(first_check.start(), back.start(), "a name check comes before the revert")

        revert = appearance_function("revertFont")
        self.assertIn("clearTimeout(fontTimer)", revert)
        self.assertRegex(revert, r"\.remove\(\)")
        self.assertRegex(revert, r"style\.setProperty\([^)]*pageFontVar\)")
        self.assertRegex(revert, r"style\.removeProperty\(")
        revert_src = appearance_function("revertFont", code=False)
        self.assertTrue(live_matches(revert_src, r"querySelectorAll\('link\[data-ws-font-preview\]'\)"),
                        "the revert doesn't remove the preview stylesheets")
        self.assertTrue(live_matches(revert_src, r"setProperty\('--font-display', pageFontVar\)"))
        self.assertTrue(live_matches(revert_src, r"removeProperty\('--font-display'\)"))
        # Every preview stylesheet carries the mark the revert looks for.
        self.assertTrue(live_matches(src, r"setAttribute\('data-ws-font-preview', ''\)"))
        self.assertTrue(live_matches(src, r"style\.setProperty\('--font-display', "))

    def test_a_saved_font_becomes_the_page_font(self):
        # After a save the font on screen is the saved one, served by the
        # preview stylesheet. A later edit + Discard must return to it at once
        # (the revert path), not re-fetch it, so a save moves pageFont and
        # pageFontVar to the saved font.
        src = APPEARANCE.read_text(encoding="utf-8")
        code = js_code_only(src)
        hook = re.search(r"api\.onSaved\(function \((\w+)\) \{", code)
        self.assertIsNotNone(hook, "nothing listens for a save")
        body = code[hook.end() - 1:matching_brace(code, hook.end() - 1) + 1]
        self.assertRegex(body, rf"{hook.group(1)}\.indexOf\(' {{10}}'\)")
        self.assertRegex(body, r"\bpageFont = api\.get\(' {10}'\)")
        body_src = src[src.index("api.onSaved(function ("):]
        self.assertTrue(live_matches(body_src[:body_src.index("});") + 3], r"api\.get\('theme\.font'\)"))
        self.assertRegex(body, r"\bpromote\(")
        # Promoting takes the stylesheet out of the previews and makes the
        # variable as it stands the one a revert restores.
        promote = appearance_function("promote")
        self.assertRegex(promote, r"\.removeAttribute\(' {20}'\)")
        self.assertRegex(promote, r"\bpageFontVar = root\.style\.getPropertyValue\(' {14}'\)")
        self.assertRegex(promote, r"\bbaseFont = pageFont\b")
        self.assertTrue(live_matches(appearance_function("promote", code=False),
                                     r"removeAttribute\('data-ws-font-preview'\)"))
        # A saved font still loading is promoted when it lands.
        self.assertRegex(appearance_function("loadFont"), r"if \(name === pageFont\) promote\(link\)")
        # A revert while the saved font isn't on screen yet fetches it.
        self.assertRegex(appearance_function("revertFont"), r"if \(baseFont !== pageFont\) loadFont\(pageFont\);")

    def test_typing_waits_long_enough(self):
        # Half-typed names shouldn't be fetched between keystrokes.
        m = re.search(r"\bvar TYPING_DELAY = (\d+);", js_code_only(APPEARANCE.read_text(encoding="utf-8")))
        self.assertIsNotNone(m)
        self.assertGreaterEqual(int(m.group(1)), 500)

    def test_reset_asks_first(self):
        code = js_code_only(APPEARANCE.read_text(encoding="utf-8"))
        self.assertEqual(len(re.findall(r"\bapi\.stageDefaults\(", code)), 1)
        ask = re.search(r"WSSettings\.confirm\(\{([^{}]*)\}\)\.then\(function \(ok\) \{\s*"
                        r"if \(ok\) api\.stageDefaults\(KEYS\);\s*\}\)", code)
        self.assertIsNotNone(ask, "Reset stages the defaults without asking")
        self.assertNotIn("alert", ask.group(1))          # a real choice: Reset or Cancel
        self.assertIn("cancelLabel", ask.group(1))

    def test_no_palette_colours_or_default_hexes(self):
        # Defaults come from meta (stageDefaults); colours from the theme.
        # js_code_only blanks strings, where a class or hex would sit, so
        # these read the whole file, comments included (stricter).
        src = APPEARANCE.read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b", src), "a hex colour")
        self.assertIsNone(ANY_PALETTE.search(src), "a palette colour")
        self.assertIsNone(PALETTE_TEXT.search(src), "an off-theme text colour")
        for badge in ("badge-media-movie", "badge-media-tv", "badge-media-book"):
            self.assertIn(f"'{badge}'", src)
        # Live code never paints a colour itself: colours go through api.color.
        code = js_code_only(src)
        self.assertNotRegex(code, r"\.style\.(?:color|background(?:Color)?)\s*=")
        self.assertEqual(live_matches(src, r"setProperty\('--(?:color|hex)-[\w-]*'"), [])


SIGNIN = STATIC / "js" / "settings" / "signin.js"


def signin_function(name: str, code: bool = True) -> str:
    """One top-level function of signin.js, as live code (comments removed,
    strings blanked) or, with code=False, as written."""
    src = SIGNIN.read_text(encoding="utf-8")
    js = js_code_only(src) if code else src
    m = re.search(rf"\n  function {name}\(.*?(?=\n  function |\n  WSSettings\.registerTab)", js, re.S)
    if m is None:
        raise AssertionError(f"signin.js has no top-level function {name}()")
    return m.group(0)


class SignInTab(unittest.TestCase):
    """The Sign-in tab's security rules that can be read from the code (R62)."""

    def test_mask_comes_from_the_kit(self):
        # A saved Plex token reads as the server's mask, which the kit
        # re-exports. No copy of it here: compared live, never a string.
        src = SIGNIN.read_text(encoding="utf-8")
        code = js_code_only(src)
        self.assertNotIn("***masked***", src)
        self.assertTrue(live_matches(src, r"\('integration\.plex\.token'\)\s*===\s*WSSettings\.MASK\b"),
                        "the Plex token isn't compared with WSSettings.MASK")
        self.assertNotRegex(code, r"\bMASK\s*[:=]\s*['\"`]")

    def test_own_method_warning_asks_with_the_kit_dialog_before_saving(self):
        # Turning off the method this session signed in with asks first, in
        # the kit's dialog, from a beforeSave hook: its answer decides the save.
        code = js_code_only(SIGNIN.read_text(encoding="utf-8"))
        hooks = list(re.finditer(r"api\.beforeSave\(function \((\w+)\) \{", code))
        self.assertEqual(len(hooks), 1, "one beforeSave hook")
        hook = hooks[0]
        body = code[hook.end() - 1:matching_brace(code, hook.end() - 1) + 1]
        self.assertRegex(body, r"\bsessionMethod\(\)")
        self.assertRegex(signin_function("sessionMethod"), r"\bWS\.user\b[\s\S]*\.auth_method\b")
        # Only when a key of that method is in the batch being saved.
        self.assertRegex(body, rf"\b{hook.group(1)}\.indexOf\(")
        ask = re.search(r"return WSSettings\.confirm\(\{([^{}]*)\}\)\.then\(function \((\w+)\) \{", body)
        self.assertIsNotNone(ask, "the warning isn't the kit's dialog, or its answer is ignored")
        self.assertNotIn("alert", ask.group(1))          # a real choice
        self.assertIn("cancelLabel", ask.group(1))
        answer = body[ask.end() - 1:matching_brace(body, ask.end() - 1) + 1]
        self.assertRegex(answer, rf"return {ask.group(2)};")

    def test_password_fields_are_the_browsers_and_never_the_kits(self):
        src = SIGNIN.read_text(encoding="utf-8")
        fields = re.findall(r"\bvar (\w+) = field\(\s*'(\w+)',\s*'[^']*',\s*'password',\s*'([a-z-]+)'", src)
        self.assertEqual([f[2] for f in fields], ["current-password", "new-password", "new-password"])
        for _, name, _ in fields:
            self.assertEqual(len(live_matches(src, rf"field\(\s*'{name}'")), 1, name)
        pw_vars = [f[0] for f in fields]
        account = signin_function("accountForm")
        make = re.search(r"\n    function field\(.*?\n    \}", account, re.S)
        self.assertIsNotNone(make, "no field() helper")
        self.assertRegex(make.group(0), r"\.type = type;")
        self.assertRegex(make.group(0), r"\.autocomplete = autocomplete;")
        # The form never touches the kit: no api, no staging, nothing logged or stored.
        self.assertRegex(account, r"^\s*function accountForm\(\) \{")
        for bad in (r"\bapi\b", r"\bstage\(", r"\btrack\(", r"\.set\(", r"console\.", r"Storage\b",
                    r"WSSettings\.values", r"\bWS\.user\s*=[^=]"):
            self.assertNotRegex(account, bad)
        mount = js_code_only(src)[js_code_only(src).index("WSSettings.registerTab("):]
        self.assertRegex(mount, r"\baccountForm\(\)")
        # A password is read only into the request body, else only cleared.
        body = re.search(r"var body = \{", account)
        self.assertIsNotNone(body, "no request body")
        span = (body.end() - 1, matching_brace(account, body.end() - 1))
        for v in pw_vars:
            reads = list(re.finditer(rf"\b{v}\.input\.value\b", account))
            self.assertTrue(any(span[0] < m.start() < span[1] for m in reads), f"{v} never reaches the body")
            for m in reads:
                inside = span[0] < m.start() < span[1]
                cleared = re.match(r"\s*=\s*'';", account[m.end():])
                self.assertTrue(inside or cleared, f"{v}.input.value is read outside the request body")
        # Cleared after every outcome: a refused form, and any answer (or none).
        clear = re.search(r"function clearPasswords\(\) \{([^{}]*)\}", account)
        self.assertIsNotNone(clear, "no clearPasswords()")
        for v in pw_vars:
            self.assertRegex(clear.group(1), rf"\b{v}\.input\.value = ''")
        self.assertRegex(account, r"if \(problem\) \{\s*clearPasswords\(\);")
        self.assertRegex(account, r"\.then\(function \((\w+)\) \{\s*clearPasswords\(\);")

    def test_account_errors_are_plain_and_401_leaves_through_the_kit(self):
        fail = signin_function("accountFailure")
        self.assertRegex(fail, r"=== 401\) \{[^{}]*WSSettings\.leave\(")
        self.assertTrue(live_matches(signin_function("accountFailure", code=False), r"WSSettings\.leave\('/login'\)"))
        # The server's words only for a 400, and only when they are a sentence.
        self.assertRegex(fail, r"=== 400 && \w+ && typeof \w+\.detail === ' {6}' && \w+\.detail\) return \w+\.detail;")
        self.assertEqual(len(re.findall(r"\.detail\b", fail)), 3, "the detail is shown outside the 400 branch")
        # A body that isn't JSON never reaches the admin as a parser error.
        read = signin_function("readBody")
        self.assertRegex(read, r"\.text\(\)")
        self.assertRegex(read, r"try \{[^{}]*JSON\.parse\([^{}]*\} catch\b")
        code = js_code_only(SIGNIN.read_text(encoding="utf-8"))
        self.assertNotRegex(code, r"location\.href\s*=(?!=)|location\.reload\(")
        self.assertNotRegex(code, r"\.json\(\)")

    def _mount_function(self, name: str) -> str:
        """A function declared inside the tab's mount(), as live code."""
        code = js_code_only(SIGNIN.read_text(encoding="utf-8"))
        m = re.search(rf"\n      function {name}\([^)]*\) \{{", code)
        self.assertIsNotNone(m, f"mount() has no function {name}()")
        return code[m.start():matching_brace(code, m.end() - 1) + 1]

    def test_all_off_line_follows_usable_methods(self):
        # "No method works" means on AND set up (the rule the warning uses),
        # not just a switch reading 'true': Plex on with no connection counts
        # for nothing.
        body = self._mount_function("syncAll")
        self.assertRegex(body, r"\busable\(\s*\w+\s*,\s*api\.get\s*\)")
        self.assertNotRegex(body, r"===\s*' {4}'")         # no raw 'true' check
        # Setup on this tab and on Integrations changes the answer too.
        src = SIGNIN.read_text(encoding="utf-8")
        keys = re.search(r"var METHOD_KEYS = \[([^\]]*)\]", src)
        self.assertIsNotNone(keys, "no METHOD_KEYS")
        for k in ("features.show_simple_auth", "features.show_plex_auth", "features.show_authentik_auth",
                  "integration.authentik.url", "integration.authentik.client_id"):
            self.assertIn(f"'{k}'", keys.group(1), k)
        code = js_code_only(src)
        self.assertRegex(code, r"METHOD_KEYS\.forEach\(function \((\w+)\) \{ api\.onChange\(\1, syncAll\); \}\)")
        self.assertRegex(code, r"addEventListener\(' {17}', syncAll\)")

    def test_authentik_fields_stay_open_while_they_hold_a_change(self):
        # Turning Authentik off must not hide a field with a staged value (and
        # the error the server may put on it), and clearing the address
        # re-checks too, not only the switch.
        body = self._mount_function("syncAk")
        self.assertIn("api.dirtyKeys()", body)
        self.assertRegex(body, r"\bAK_KEYS\b")
        src = SIGNIN.read_text(encoding="utf-8")
        keys = re.search(r"var AK_KEYS = \[([^\]]*)\]", src)
        self.assertIsNotNone(keys, "no AK_KEYS")
        for k in ("features.show_authentik_auth", "integration.authentik.url", "integration.authentik.app_slug",
                  "integration.authentik.client_id", "integration.authentik.client_secret"):
            self.assertIn(f"'{k}'", keys.group(1), k)
        self.assertRegex(js_code_only(src), r"AK_KEYS\.forEach\(function \((\w+)\) \{ api\.onChange\(\1, syncAk\); \}\)")

    def test_password_manager_hint_takes_the_name_sent(self):
        # The name typed while the request was out isn't the one saved.
        account = signin_function("accountForm")
        take = re.search(r"var sentName = body\.new_username;", account)
        send = account.find("sendAccount(body)")
        self.assertIsNotNone(take, "the sent name isn't kept")
        self.assertLess(take.start(), send)
        self.assertRegex(account[send:], r"\bwho\.value = sentName;")
        self.assertEqual(len(re.findall(r"\bwho\.value = ", account)), 2)      # set up, then the sent name
        self.assertNotRegex(account[send:], r"\bwho\.value = (?!sentName;)")

    def test_plex_link_opens_integrations_even_before_the_card_exists(self):
        # Task 6.3 gives the Plex card its id. Until then go() just opens the
        # Integrations tab: only the kit looks the card up, and it skips one
        # that isn't there.
        src = SIGNIN.read_text(encoding="utf-8")
        self.assertTrue(live_matches(src, r"var PLEX_CARD = 'integration-card-plex';"))
        self.assertTrue(live_matches(src, r"WSSettings\.go\('integrations', PLEX_CARD\)"))
        self.assertNotRegex(js_code_only(src), r"getElementById\(|querySelector(?:All)?\(|\bPLEX_CARD\)\.")
        self.assertRegex(kit_code(), r"var target = document\.getElementById\(S\.pendingFocus\.id\);"
                                     r"\s*S\.pendingFocus = null;\s*if \(target\) \{")


PAGES = STATIC / "js" / "settings" / "pages.js"
# Page ids as the settings registry names them; pages.js must not list them.
PAGE_IDS = ("home", "requests", "issues", "calendar", "tickets", "library", "wiki", "settings")


def pages_function(name: str, code: bool = True) -> str:
    """One top-level function of pages.js, as live code (comments removed,
    strings blanked) or, with code=False, as written."""
    src = PAGES.read_text(encoding="utf-8")
    js = js_code_only(src) if code else src
    m = re.search(rf"\n  function {name}\(.*?(?=\n  function |\n  // ---- |\n  WSSettings\.registerTab)", js, re.S)
    if m is None:
        raise AssertionError(f"pages.js has no top-level function {name}()")
    return m.group(0)


def pages_mount_part(pattern: str, code: bool = True) -> str:
    """The block opened by the first match of pattern inside the tab's mount()
    (a function or a handler), up to its closing brace: as live code, or with
    code=False as written. js_code_only drops comments, so the written form
    is found in the source itself and ends at the first line holding only
    the block's own indentation and a closing brace."""
    src = PAGES.read_text(encoding="utf-8")
    text = js_code_only(src) if code else src
    mount = text.index("WSSettings.registerTab(")
    m = re.compile(pattern).search(text, mount)
    if m is None:
        raise AssertionError(f"mount() has no {pattern}")
    if code:
        open_at = text.index("{", m.end() - 1)
        return text[m.start():matching_brace(text, open_at) + 1]
    line_start = text.rindex("\n", 0, m.start() + 1) + 1
    indent = re.match(r"[ ]*", text[line_start:]).group(0)
    close = re.compile(r"\n" + indent + r"\}").search(text, m.end())
    if close is None:
        raise AssertionError(f"no closing brace for {pattern}")
    return text[m.start():close.end()]


class PagesTab(unittest.TestCase):
    """The Pages tab's order, reorder and fetch rules that can be read from the code (R67)."""

    def test_order_and_addresses_come_from_the_server(self):
        # R14: page_order (normalised) and page_addresses are the Settings
        # view's, re-exported by the kit; no copy of either, and no own
        # normaliser, lives here.
        src = PAGES.read_text(encoding="utf-8")
        code = js_code_only(src)
        self.assertEqual(len(live_matches(src, r"WSSettings\.view\('page_order'\)")), 1)
        self.assertEqual(len(live_matches(src, r"WSSettings\.view\('page_addresses'\)")), 1)
        self.assertNotRegex(code, r"\b(?:parseOrder|defaultOrder|ADDRESS(?:ES)?|normali[sz]e\w*)\b")
        for route in ("/ebooks", "/requests", "/issues", "/calendar", "/tickets", "/wiki", "/settings"):
            self.assertNotIn(f"'{route}'", src, route)
        ids = "|".join(PAGE_IDS)
        self.assertIsNone(re.search(rf"\[[^\[\]]*'(?:{ids})'[^\[\]]*'(?:{ids})'[^\[\]]*\]", src),
                          "a list of page ids")
        # The only JSON read here is the monitors answer; pages.order is never parsed.
        self.assertEqual(code.count("JSON.parse("), pages_function("readJson").count("JSON.parse("))
        self.assertEqual(code.count("JSON.parse("), 1)
        # The rows are the server's order.
        self.assertRegex(code, r"start\.forEach\(function \(id\) \{ rows\[id\] = buildRow\(id\);")
        kit = kit_code()
        self.assertRegex(kit, r"\bS\.view = data;")
        self.assertRegex(kit, r"function view\(name\) \{\s*return hasOwn\(S\.view, name\) \? S\.view\[name\] : null;")

    def test_every_reorder_goes_through_commit(self):
        # Dragging, the arrow keys and the phone buttons all stage the order
        # through one commit(); nothing else writes pages.order.
        src = PAGES.read_text(encoding="utf-8")
        code = js_code_only(src)
        self.assertEqual(len(re.findall(r"\bfunction commit\(", code)), 1)
        commit = pages_mount_part(r"\n      function commit\(")
        start = code.index(commit)
        for m in re.finditer(r"\bapi\.set\(", code):
            self.assertTrue(start < m.start() < start + len(commit), "pages.order is staged outside commit()")
        self.assertIn("api.set(ORDER_KEY, ", commit)
        self.assertTrue(live_matches(src, r"var ORDER_KEY = 'pages\.order';"))
        self.assertNotIn("stageDefaults", code)
        self.assertRegex(pages_mount_part(r"\n      function move\("), r"\bcommit\(\w+, id\);")
        self.assertRegex(pages_mount_part(r"list\.addEventListener\(' {4}', function \(e\) \{"), r"\bcommit\(")
        keys = pages_mount_part(r"handle\.addEventListener\(' {7}', function \(e\) \{")
        self.assertRegex(keys, r"\bmove\(id, e\.key === ' {7}' \? -1 : 1\);")
        self.assertNotIn("commit(", keys)
        self.assertRegex(code, r"\bup\.addEventListener\(' {5}', function \(\) \{ move\(id, -1\);")
        self.assertRegex(code, r"\bdown\.addEventListener\(' {5}', function \(\) \{ move\(id, 1\);")
        # The list repaints from the tracked value, whoever staged it.
        self.assertRegex(code, r"api\.track\(ORDER_KEY, \{[^\n]*\bset: paint\b")

    def test_first_and_last_pages_stay_put(self):
        # Home first and Settings last, exactly as normalize_page_order keeps
        # them: taken from the server's order, held by commit(), no handle.
        code = js_code_only(PAGES.read_text(encoding="utf-8"))
        self.assertRegex(code, r"var FIRST = start\[0\], LAST = start\[start\.length - 1\];")
        commit = pages_mount_part(r"\n      function commit\(")
        self.assertRegex(commit, r"if \(id !== FIRST && id !== LAST && hasOwn\(rows, id\) && middle\.indexOf\(id\) < 0\)")
        self.assertRegex(commit, r"var order = \[FIRST\]\.concat\(middle, \[LAST\]\);")
        self.assertRegex(commit, r"if \(order\.length !== shown\.length\) return;")
        self.assertRegex(pages_mount_part(r"\n      function move\("), r"i < 1 \|\| j < 1 \|\| j > order\.length - 2")
        target = pages_mount_part(r"\n      function dropTarget\(")
        self.assertIn("if (id === FIRST) after = true;", target)
        self.assertIn("if (id === LAST) after = false;", target)
        row = pages_mount_part(r"\n      function buildRow\(")
        self.assertRegex(row, r"var pinned = id === FIRST \|\| id === LAST;")
        guard = re.search(r"if \(!pinned\) \{", row)
        self.assertIsNotNone(guard, "the handle isn't kept off the pinned rows")
        block = row[guard.end() - 1:matching_brace(row, guard.end() - 1) + 1]
        made = re.findall(r"\bhandle = el\(", row)
        self.assertEqual(len(made), 1, "one handle, made in one place")
        self.assertRegex(block, r"\bhandle = el\(")

    def test_keyboard_reorder_keeps_focus_and_is_announced(self):
        src = PAGES.read_text(encoding="utf-8")
        keys = pages_mount_part(r"handle\.addEventListener\(' {7}', function \(e\) \{")
        self.assertIn("e.preventDefault();", keys)
        self.assertRegex(keys, r"handle\.focus\(")
        # The row with focus stays put in the DOM while the others move.
        paint = pages_mount_part(r"\n      function paint\(")
        self.assertRegex(paint, r"rows\[id\]\.contains\(document\.activeElement\)")
        self.assertRegex(paint, r"if \(k < at\) list\.insertBefore\(rows\[id\], rows\[anchor\]\);")
        self.assertRegex(paint, r"else if \(k > at\) list\.appendChild\(rows\[id\]\);")
        self.assertTrue(live_matches(src, r"live\.setAttribute\('aria-live', 'polite'\)"))
        self.assertRegex(pages_mount_part(r"\n      function commit\("), r"if \(moved\) say\(")
        self.assertRegex(pages_mount_part(r"\n      function say\("), r"live\.textContent = text")

    def test_row_names_follow_the_label(self):
        # WCAG 2.5.3: every accessible name in a row carries the page's label
        # as it stands now. A rename (staged, discarded or saved) renames the
        # group, the handle, the move buttons, the expander and both switches.
        src = PAGES.read_text(encoding="utf-8")
        row = pages_mount_part(r"\n      function buildRow\(")
        row_src = pages_mount_part(r"\n      function buildRow\(", code=False)
        # One listener on the row's own label key; the kit calls onChange
        # listeners on a staged change, on Discard and after a save.
        self.assertRegex(row, r"api\.onChange\(' {14}' \+ id, nameRow\);")
        self.assertTrue(live_matches(row_src, r"api\.onChange\('sidebar\.label_' \+ id, nameRow\)"))
        self.assertRegex(kit_code(), r"function discard\(id\) \{[\s\S]*?notify\(t, k\);")
        self.assertRegex(kit_code(), r"function applySaved\([\s\S]*?notify\(t, k\);")
        name = re.search(r"\n        function nameRow\(\) \{", row)
        self.assertIsNotNone(name, "buildRow has no nameRow()")
        body = row[name.start():matching_brace(row, name.end() - 1) + 1]
        self.assertRegex(body, r"var \w+ = labelOf\(api, id\);")
        named = set(re.findall(r"\b(\w+)\.setAttribute\(' {10}',", body))
        for el in ("line", "handle", "up", "down", "toggleBtn", "newSwitch", "onSwitch"):
            self.assertIn(el, named, el)
        # No name baked in once at build time (outside nameRow).
        self.assertNotRegex(row.replace(body, ""), r"\blabelOf\(")
        self.assertNotRegex(js_code_only(src), r"label: ' {9}' \+ name")

    def test_nothing_moves_while_dragging(self):
        # A drag only draws the drop line (absolutely placed, in the gap);
        # rows change places once, on drop.
        over = pages_mount_part(r"list\.addEventListener\(' {8}', function \(e\) \{")
        self.assertNotRegex(over, r"\b(?:commit|move|paint)\(|insertBefore|appendChild|\.style\.")
        self.assertRegex(over, r"classList\.add\(")
        src = PAGES.read_text(encoding="utf-8")
        self.assertTrue(live_matches(src, r"'ws-drop-after' : 'ws-drop-before'"))
        self.assertRegex(pages_mount_part(r"\n      function buildRow\(", code=False), r"el\('li', 'relative ")
        css = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        rule = re.search(r"\.ws-drop-before::before, \.ws-drop-after::before \{([^}]*)\}", css)
        self.assertIsNotNone(rule)
        self.assertIn("position: absolute", rule.group(1))
        self.assertIn("rgb(var(--color-primary))", rule.group(1))

    def test_monitor_list_failures_are_plain(self):
        # 401 -> sign in again through the kit; anything else that isn't a
        # JSON list (5xx, no answer, an error page) -> a plain line, no list.
        src = PAGES.read_text(encoding="utf-8")
        self.assertTrue(live_matches(src, r"var MONITORS_URL = '/api/integrations/monitors';"))
        load = pages_function("loadMonitors")
        self.assertRegex(load, r"fetch\(MONITORS_URL, \{[^{}]*\}\)\s*\.then\(readJson, function \(\) \{ return \{ status: 0,")
        self.assertRegex(load, r"=== 401\) \{ WSSettings\.leave\(")
        self.assertTrue(live_matches(pages_function("loadMonitors", code=False), r"WSSettings\.leave\('/login'\)"))
        failed = re.search(r"if \(res\.status !== 200 \|\| !Array\.isArray\(res\.data\)\) \{([^{}]*)", load)
        self.assertIsNotNone(failed, "a non-list answer isn't refused")
        self.assertRegex(failed.group(1), r"list\.replaceChildren\(actionNote\(MSG\.monitorsFailed")
        self.assertLess(load.index("=== 401)"), failed.start())
        read = pages_function("readJson")
        self.assertRegex(read, r"\.text\(\)")
        self.assertRegex(read, r"try \{[^{}]*JSON\.parse\([^{}]*\} catch\b")
        code = js_code_only(src)
        self.assertNotRegex(code, r"\.json\(\)|\.detail\b|location\.href\s*=(?!=)|location\.reload\(")
        # Every id becomes a setting key: digits only.
        # (A regex literal's body is blanked in live code, so read it as written.)
        self.assertIn(r"/^\d{1,9}$/.test(String(m.id))", pages_function("loadMonitors", code=False))
        self.assertIn(".test(String(m.id))", load)

    def test_requests_source_options_come_from_meta(self):
        body_src = pages_function("requestsExpander", code=False)
        body = pages_function("requestsExpander")
        self.assertTrue(live_matches(body_src, r"WSSettings\.metaFor\('requests\.source'\)"))
        self.assertRegex(body, r"var choices = m && Array\.isArray\(m\.choices\) \? m\.choices : \[\];")
        self.assertRegex(body, r"options: choices\.map\(")
        self.assertNotRegex(body_src, r"value:\s*'")

    def test_setup_links_open_integrations_even_before_the_cards_exist(self):
        # Task 6.3 gives each card its id; until then go() just opens the tab.
        src = PAGES.read_text(encoding="utf-8")
        self.assertTrue(live_matches(src, r"WSSettings\.go\('integrations', 'integration-card-' \+ service\)"))
        code = js_code_only(src)
        self.assertNotIn("getElementById(", code)
        self.assertEqual(code.count("querySelector"), 1)
        self.assertIn("querySelector(", pages_function("nameField"))


INTEGRATIONS = STATIC / "js" / "settings" / "integrations.js"


class IntegrationsTab(unittest.TestCase):
    """The Integrations tab's rules that can be read from the code (R79)."""

    def _mount(self) -> str:
        """The registered mount()'s body, as live code."""
        code = js_code_only(INTEGRATIONS.read_text(encoding="utf-8"))
        m = re.search(r"WSSettings\.registerTab\(' {12}', \{\s*mount: function \(panel, api\) \{", code)
        self.assertIsNotNone(m, "no mount(panel, api)")
        return code[m.end():matching_brace(code, m.end() - 1)]

    def test_mount_does_not_wait_for_the_checks(self):
        # R79 (d): a cold health check can take 5 s. The cards arrive at once
        # with "Checking…"; mount() starts the check and returns nothing for
        # the kit to wait on.
        mount = top_level(self._mount())
        self.assertRegex(mount, r"(?:^|[;}])\s*refresh\(\);\s*$", "the first check isn't started last, on its own")
        self.assertNotRegex(mount, r"\breturn\b", "mount() returns something the kit would wait on")
        self.assertNotRegex(mount, r"\bawait\b|\basync\b")
        # Every card starts on "Checking…", in a status line of fixed height.
        src = INTEGRATIONS.read_text(encoding="utf-8")
        self.assertTrue(live_matches(src, r"var light = el\('span', 'ws-light ws-light-checking'\);"))
        self.assertTrue(live_matches(src, r"var reason = el\('span', '[^']*\btruncate\b[^']*', MSG\.checking\);"))
        status = live_matches(src, r"var status = el\('p', '([^']*)'\);")
        self.assertEqual(len(status), 1)
        self.assertIn("h-5", status[0].group(1).split())

    def test_saved_secrets_are_compared_with_the_kits_mask(self):
        # R79 (a, b): "address and key saved" reads the saved values through
        # api.saved and compares the key with WSSettings.MASK; no literal copy
        # of the mask and no WSSettings.values.
        src = INTEGRATIONS.read_text(encoding="utf-8")
        code = js_code_only(src)
        self.assertNotIn("***masked***", src)
        # The whole gate, one expression: either half missing means typed fields.
        gate = live_matches(src, r"if \(!api\.saved\('integration\.chaptarr\.url'\) \|\| "
                                 r"api\.saved\('integration\.chaptarr\.api_key'\) !== WSSettings\.MASK\) \{")
        self.assertEqual(len(gate), 1, "the saved-address-and-key gate")
        self.assertNotRegex(code, r"\bMASK\s*[:=]\s*['\"`]")
        self.assertNotRegex(code, r"WSSettings\.values\b")

    def test_a_save_rechecks_its_cards_and_reloads_chaptarrs_lists(self):
        # R72 (2), R79 (a, g): after a save, each card whose keys were in it
        # asks for a fresh check of that one service, and a save of Chaptarr's
        # address or key loads its lists again, without a page reload.
        src = INTEGRATIONS.read_text(encoding="utf-8")
        code = js_code_only(src)
        hook = re.search(r"document\.addEventListener\(' {17}', function \((\w+)\) \{", code)
        self.assertIsNotNone(hook, "nothing listens for a save")
        self.assertTrue(live_matches(src, r"document\.addEventListener\('ws-settings:saved', function"))
        body = code[hook.end() - 1:matching_brace(code, hook.end() - 1) + 1]
        self.assertRegex(body, r"if \(touches\(keys, keysOf\(id\)\)\) \{ cards\[id\]\.clearResult\(\); refresh\(id\); \}")
        self.assertRegex(body, r"if \(chaptarr && touches\(keys, CHAPTARR_CONN\)\) loadChoices\(\);")
        self.assertTrue(live_matches(src, r"var CHAPTARR_CONN = \['integration\.chaptarr\.url', 'integration\.chaptarr\.api_key'\];"))
        self.assertTrue(live_matches(src, r"'\?refresh=1&service=' \+ encodeURIComponent\(id\)"))

    def test_cards_carry_the_ids_other_tabs_link_to(self):
        # Pages and Sign-in open a card with WSSettings.go('integrations',
        # 'integration-card-<id>'); the kit scrolls to it and focuses it, and
        # the card opens on that focus.
        src = INTEGRATIONS.read_text(encoding="utf-8")
        self.assertTrue(live_matches(src, r"root\.id = 'integration-card-' \+ id;"))
        self.assertTrue(live_matches(src, r"root\.tabIndex = -1;"))
        self.assertTrue(live_matches(src, r"root\.addEventListener\('focus', function"))
        for card in ("plex", "kavita", "seerr", "chaptarr"):
            self.assertRegex(src, rf"\n    {card}: \{{ name: ", card)

    def _mount_function(self, name: str) -> str:
        """A function declared inside the tab's mount() (or a card builder), as live code."""
        code = js_code_only(INTEGRATIONS.read_text(encoding="utf-8"))
        m = re.search(rf"\n {{6,8}}function {name}\([^)]*\) \{{", code)
        self.assertIsNotNone(m, f"no function {name}()")
        return code[m.start():matching_brace(code, m.end() - 1) + 1]

    def test_lights_take_only_fresh_entries(self):
        # Fix round 1 (1, 3): an answer to refresh=1&service=X carries every
        # other card's cached entry. A card takes its own entry only from an
        # answer to a request that asked for it (and no newer one since); an
        # id the answer left out is "couldn't check", never "Checking…"
        # forever. Another card's entry is taken only while nothing is being
        # asked for that card, and only if it is no older than what it shows.
        body = self._mount_function("refresh")
        self.assertRegex(body, r"ids\.forEach\(function \(k\) \{ asked\[k\] = mine; inflight\[k\] = mine; \}\);")
        ok = re.search(r"\.then\(function \(data\) \{", body)
        self.assertIsNotNone(ok)
        branch = body[ok.end() - 1:matching_brace(body, ok.end() - 1) + 1]
        self.assertRegex(branch, r"^\{\s*settle\(ids, mine\);")
        self.assertRegex(branch, r"if \(ids\.indexOf\(k\) >= 0\) \{\s*if \(mine >= \(asked\[k\] \|\| 0\)\) "
                                 r"health\[k\] = entry \|\| UNAVAILABLE\(\);\s*\} "
                                 r"else if \(entry && !inflight\[k\] && newer\(entry, health\[k\]\)\) \{\s*health\[k\] = entry;")
        self.assertEqual(len(re.findall(r"\bhealth\[k\] = ", branch)), 2, "no other write to a card's entry")
        fail = re.search(r"\.catch\(function \(\) \{", body)
        self.assertRegex(body[fail.end():], r"^\s*settle\(ids, mine\);")
        self.assertRegex(self._mount_function("settle"), r"if \(inflight\[k\] === mine\) delete inflight\[k\];")
        # R83: checked_at has whole-second resolution, so another card's
        # cached entry from the same second may be staler than the answer the
        # card already has: only a strictly newer one (or a first one) lands.
        newer = self._mount_function("newer")
        self.assertRegex(newer, r"\{\s*if \(!old\) return true;")
        self.assertRegex(newer, r"return !b \|\| \(!!a && a > b\);")
        self.assertNotRegex(newer, r">=")

    def test_every_state_has_a_visible_light(self):
        # Fix round 1 (2): "couldn't check" (the client's own 'unknown') and any
        # state the server might add get a filled neutral dot, never a bare
        # 'ws-light ' with its reason and no mark.
        src = INTEGRATIONS.read_text(encoding="utf-8")
        light = live_matches(src, r"var LIGHT = \{([^}]*)\};")
        self.assertEqual(len(light), 1)
        states = dict(re.findall(r"(\w+): '([\w-]+)'", light[0].group(1)))
        self.assertEqual(states, {"ok": "ws-light-ok", "warn": "ws-light-warn", "error": "ws-light-error",
                                  "unconfigured": "ws-light-off", "unknown": "ws-light-unconfigured"})
        self.assertTrue(live_matches(src, r"state: 'unknown', reason: MSG\.unavailable"))
        self.assertRegex(self._mount_function("paint"), r"\(h \? \(LIGHT\[h\.state\] \|\| LIGHT\.unknown\) : ")
        self.assertNotRegex(js_code_only(src), r"LIGHT\[[^\]]+\] \|\| ' *'")

    def test_checked_ago_rounds_before_it_chooses_the_unit(self):
        # Fix round 1 (4): 3570-3599 s rounds to 60 minutes, which is "1 h".
        code = js_code_only(INTEGRATIONS.read_text(encoding="utf-8"))
        body = function_body(code, "ago")
        self.assertRegex(body, r"var m = Math\.round\(s / 60\);\s*if \(m < 60\) return ' {8}' \+ m \+ ' {8}';")
        self.assertNotRegex(body, r"s < 3600")

    def test_a_stale_test_answer_is_dropped(self):
        # Fix round 1 (5): Save, Discard and a newer Test move the card's test
        # number on; an answer still in flight from before is dropped, so it
        # can't write over the cleared result.
        src = INTEGRATIONS.read_text(encoding="utf-8")
        code = js_code_only(src)
        clear = self._mount_function("clearResult")
        self.assertRegex(clear, r"\{\s*testSeq \+= 1;\s*result\.replaceChildren\(\);\s*\}")
        click = re.search(r"testBtn\.addEventListener\(' {5}', function \(\) \{", code)
        self.assertIsNotNone(click)
        handler = code[click.end() - 1:matching_brace(code, click.end() - 1) + 1]
        self.assertRegex(handler, r"var mine = \+\+testSeq;")
        answer = re.search(r"\.then\(readJson\)\.then\(function \(res\) \{", handler)
        self.assertIsNotNone(answer)
        after = handler[answer.end():]
        guard = re.search(r"if \(mine !== testSeq\) return;", after)
        self.assertIsNotNone(guard, "the answer isn't checked against the test number")
        self.assertLess(guard.start(), after.index("showResult("), "the result is shown before the check")
        self.assertRegex(handler, r"\.catch\(function \(\) \{\s*if \(mine === testSeq\) showResult\(")
        self.assertEqual(len(re.findall(r"\bshowResult\(", handler)), 3, "every result write is accounted for")
        self.assertRegex(code, r"if \(touches\(keys, keysOf\(id\)\)\) \{ cards\[id\]\.clearResult\(\); refresh\(id\); \}")
        self.assertRegex(code, r"api\.onDiscard\(function \(\) \{\s*Object\.keys\(cards\)\.forEach\(function \(id\) "
                               r"\{ cards\[id\]\.clearResult\(\); \}\);")
        # The result is emptied only by clearResult(), which moves the number on.
        self.assertEqual(len(re.findall(r"\bresult\.replaceChildren\(\);", code)), 1)

    def test_network_units_come_from_meta(self):
        # R82: the unit values are the setting's choices; only the plain-words
        # labels live here, looked up by value, an unknown one shown as itself.
        src = INTEGRATIONS.read_text(encoding="utf-8")
        body = self._mount_function("netdataFields")
        body_src = src[src.index("function netdataFields("):]
        body_src = body_src[:body_src.index("\n      }\n") + 8]
        self.assertTrue(live_matches(body_src, r"WSSettings\.metaFor\('netdata\.net_unit'\)"))
        self.assertRegex(body, r"var units = unit && Array\.isArray\(unit\.choices\) \? unit\.choices : \[\];")
        self.assertRegex(body, r"options: units\.map\(function \((\w+)\) \{\s*return \{ value: \1, label: "
                               r"Object\.prototype\.hasOwnProperty\.call\(UNIT_LABELS, \1\) \? UNIT_LABELS\[\1\] : \1 \};")
        self.assertNotRegex(body_src, r"value:\s*'")
        labels = live_matches(src, r"var UNIT_LABELS = \{ mbps: 'Megabits per second \(Mbps\)', "
                                   r"MBps: 'Megabytes per second \(MB/s\)' \};")
        self.assertEqual(len(labels), 1)

    def test_skeleton_reserves_every_group(self):
        # Fix round 1 (8): the panel's skeleton holds one heading per group and
        # one card per service, in GROUPS order, at the measured heights
        # (phone first, then sm and up), so the swap moves nothing.
        src = INTEGRATIONS.read_text(encoding="utf-8")
        groups = re.search(r"var GROUPS = \[(.*?)\n  \];", src, re.S)
        self.assertIsNotNone(groups)
        counts = [len(re.findall(r"'(\w+)'", ids)) for ids in re.findall(r"\[\s*'[^']*',\s*\[([^\]]*)\]\]", groups.group(1))]
        self.assertEqual(counts, [1, 1, 3, 2, 2])
        h = (STATIC / FRAME).read_text(encoding="utf-8")
        panel = h[h.index('<section id="panel-integrations"'):]
        panel = panel[:panel.index("</section>")]
        heads = re.findall(r'<div class="h-\[30px\] mb-5 flex items-center">', panel)
        self.assertEqual(len(heads), len(counts), "one heading per group")
        per_group = [len(re.findall(r'class="skel rounded-2xl ', block))
                     for block in re.split(r'<div class="h-\[30px\] mb-5 flex items-center">', panel)[1:]]
        self.assertEqual(per_group, counts, "one card per service, grouped as GROUPS")
        heights = re.findall(r'class="skel rounded-2xl (h-\[[\d.]+px\](?: sm:h-\[[\d.]+px\])?)"', panel)
        tall, short = "h-[122px] sm:h-[102.6px]", "h-[102.6px]"
        self.assertEqual(heights, [tall, tall, short, tall, short, short, short, short, tall])

    def test_upstream_text_never_goes_in_as_html(self):
        code = js_code_only(INTEGRATIONS.read_text(encoding="utf-8"))
        self.assertNotRegex(code, r"innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|setHTML")
        self.assertNotRegex(code, r"\bsetInterval\(|\bsetTimeout\(")


NOTIFICATIONS = STATIC / "js" / "settings" / "notifications.js"


def notifications_function(name: str, code: bool = True) -> str:
    """One top-level function of notifications.js, as live code (comments
    removed, strings blanked) or, with code=False, as written."""
    src = NOTIFICATIONS.read_text(encoding="utf-8")
    js = js_code_only(src) if code else src
    m = re.search(rf"\n  (?://[^\n]*\n  )*function {name}\(.*?(?=\n  (?://[^\n]*\n  )*function |\n  WSSettings\.registerTab)",
                  js, re.S)
    if m is None:
        raise AssertionError(f"notifications.js has no top-level function {name}()")
    return m.group(0)


class NotificationsTab(unittest.TestCase):
    """The Notifications tab's rules that can be read from the code (R86)."""

    def test_pending_is_empty(self):
        # R86 (e): notifications.js was the last file a later task owed.
        self.assertEqual(PENDING, set())
        self.assertTrue(NOTIFICATIONS.exists())

    def test_interval_range_comes_from_meta(self):
        # R86 (c): the allowed range is each setting's own min and max, put
        # into plain words here. No copy of the numbers or of a sentence
        # naming them ("Between 30 seconds and an hour").
        src = NOTIFICATIONS.read_text(encoding="utf-8")
        code = js_code_only(src)
        rng = notifications_function("rangeOf")
        self.assertTrue(live_matches(notifications_function("rangeOf", code=False),
                                     r"var m = WSSettings\.metaFor\(key\);"), "the range isn't read from meta")
        self.assertRegex(rng, r"if \(!m \|\| typeof m\.min !== ' {6}' \|\| typeof m\.max !== ' {6}'\) return ' *';")
        self.assertRegex(rng, r"plainSeconds\(m\.min\) \+ ' +' \+ plainSeconds\(m\.max\)")
        # Every interval's range is read, and the card (or, when they differ,
        # each field) says it.
        self.assertRegex(code, r"var ranges = INTERVALS\.map\(function \((\w+)\) \{ return rangeOf\(\1\[0\]\); \}\);")
        card = re.search(r"WSSettings\.card\(' {18}',\s*\(shared \? ' {12}' \+ shared \+ ' {2}' : ' *'\) \+ MSG\.speed\)", code)
        self.assertIsNotNone(card, "the card's description doesn't carry the shared range")
        self.assertTrue(live_matches(src, r"WSSettings\.card\('How often to check',"))
        self.assertRegex(code, r"var own = !shared && ranges\[i\] \? ' {10}' \+ ranges\[i\] \+ ' ' : ' *';")
        self.assertRegex(code, r"help: x\[2\] \+ own, inputType: ' {6}', suffix: ' {7}' \}")
        # No hand-kept range: no string naming an amount of time, no bare 30
        # in live code (3600 may appear, as seconds in an hour).
        strings = re.findall(r"'([^'\n]*)'", src)
        for text in strings:
            self.assertNotRegex(text, r"\b\d+ (?:seconds?|minutes?|hours?)\b|\ban hour\b|\bhalf a minute\b", text)
        self.assertNotRegex(code, r"(?<![\d.])30(?![\d.])")

    def test_last_push_copy(self):
        # R86 (b): none since the server last started (Redis is embedded), a
        # test push says so, and the delivered count is shown as it is, 0 too.
        src = NOTIFICATIONS.read_text(encoding="utf-8")
        self.assertEqual(len(live_matches(src, r"noLastPush: 'No pushes since the server last started\.'")), 1)
        body = notifications_function("lastPushText")
        self.assertRegex(body, r"\{\s*if \(!last \|\| typeof last !== ' {6}'\) return MSG\.noLastPush;")
        self.assertRegex(body, r"last\.category === ' {4}' \? ' {9}' : ' *'")
        self.assertTrue(live_matches(notifications_function("lastPushText", code=False),
                                     r"last\.category === 'test' \? ' \(a test\)'"))
        self.assertRegex(body, r"\+ num\(last\.succeeded\) \+ ' {4}' \+ plural\(tried, ")
        self.assertEqual(len(re.findall(r"MSG\.noLastPush\b", js_code_only(src))), 1)
        self.assertRegex(notifications_function("num"), r"return typeof v === ' {6}' && isFinite\(v\) && v >= 0 \?")

    def test_no_mask_and_no_html(self):
        # The tab has no secrets: no mask, literal or the kit's. Server and
        # admin text goes in as text only; no timers but the shell's poll.
        src = NOTIFICATIONS.read_text(encoding="utf-8")
        code = js_code_only(src)
        self.assertNotIn("***masked***", src)
        self.assertNotRegex(code, r"\bMASK\b")
        self.assertNotRegex(code, r"innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|setHTML")
        self.assertNotRegex(code, r"\bsetInterval\(")
        # The one setTimeout is the cap on how long the tab waits for the status.
        self.assertEqual(len(re.findall(r"\bsetTimeout\(", code)), 1)
        self.assertRegex(code, r"return Promise\.race\(\[loadStatus\(\), new Promise\(function \((\w+)\) \{ "
                               r"setTimeout\(\1, STATUS_WAIT\); \}\)\]\);")

    def test_confirm_shows_the_title_as_text(self):
        # R86 (g): the admin's announcement title reaches the dialog as a
        # string body, which the dialog sets with textContent.
        ui = js_code_only((STATIC / "js" / "ui.js").read_text(encoding="utf-8"))
        self.assertRegex(ui, r"if \(typeof opts\.body === ' {6}'\) body\.textContent = opts\.body;")
        self.assertRegex(ui, r"var title = el\(' {2}', ' +', opts\.title \|\| ' +'\);")
        src = NOTIFICATIONS.read_text(encoding="utf-8")
        self.assertTrue(live_matches(src, r"body: '“' \+ t \+ '” goes to everyone right away\. It can’t be taken back\.',"))

    def test_session_end_leaves_through_the_kit(self):
        src = NOTIFICATIONS.read_text(encoding="utf-8")
        code = js_code_only(src)
        self.assertEqual(len(live_matches(src, r"if \(res\.status === 401\) \{ WSSettings\.leave\('/login'\); return; \}")), 3)
        self.assertNotRegex(code, r"location\.href\s*=(?!=)|location\.reload\(|\.json\(\)")


class Guards(unittest.TestCase):
    """The hygiene patterns catch what they are for and let the theme through."""

    def test_off_theme_text_colour(self):
        for bad in ('class="text-green-500"', 'class="text-white"', 'class="text-[#ff0000]"',
                    'class="text-[rgb(1,2,3)]"', 'class="text-[hsl(0 0% 50%)]"',
                    'style="font-weight:600;color: #abc"', 'style="color:rgb(0, 0, 0)"',
                    "'<span style=\"color: hsl(0,0%,50%)\">'", "el.style.color = '#fff';",
                    "el.style.color = \"rgb(1,2,3)\";"):
            self.assertIsNotNone(PALETTE_TEXT.search(bad), bad)
        for ok in ('class="text-frosted-blue/70"', 'class="text-primary"', "color: rgb(var(--color-text) / .7);",
                   "color: rgb( var(--color-text));", "background-color: #000;", "border-color: rgb(1,2,3);",
                   "el.style.color = 'rgb(var(--color-primary))';", 'class="text-[15px]"'):
            self.assertIsNone(PALETTE_TEXT.search(ok), ok)

    def test_text_under_twelve_pixels(self):
        for bad in ("text-[11px]", "text-[10.5px]", "text-[9px]", "text-[0.7rem]", "text-[.6rem]",
                    "text-[0.74rem]", "text-[0.7em]", 'style="font-size: 10px"', "font-size:0.6rem",
                    "font-size: .7em", "el.style.fontSize = '11px'", "el.style.fontSize = '0.625rem'"):
            self.assertIsNotNone(TINY_TEXT.search(bad), bad)
        for ok in ("text-[12px]", "text-[15px]", "text-[0.75rem]", "text-[.75rem]", "text-[0.8rem]",
                   "text-[1.5rem]", "text-[10.5rem]", "font-size: 12px", "font-size: 15px", "font-size: 0.75rem",
                   "font-size: 1.25rem", "el.style.fontSize = '14px'", "text-xs"):
            self.assertIsNone(TINY_TEXT.search(ok), ok)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Route(PageRoutesBase):
    def test_admins_get_the_frame_members_go_home(self):
        r = self.get("/settings/next", ADMIN_SESSION)
        self.assertEqual(r.status_code, 200)
        self.assertIn('data-page="settings-next"', r.text)
        self.assertRegex(r.text, r'<a[^>]*href="/settings"[^>]*aria-current="page"')
        r = self.get("/settings/next", MEMBER_SESSION)
        self.assertEqual((r.status_code, r.headers["location"]), (302, "/"))


if __name__ == "__main__":
    unittest.main()
