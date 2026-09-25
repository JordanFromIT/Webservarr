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

from app.tests.test_shell_contract import js_code_only

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

# Files the frame references that later tasks write. Each task deletes its own
# entries when it adds the file (a file here that exists fails the test), and
# Task 8.4 asserts the set is empty. Task 3.2 added ui.js, kit.js and the first
# General fields (general.js, which Task 4.3 completes).
PENDING = {
    "js/settings/appearance.js",         # Task 4.4
    "js/settings/signin.js",             # Task 4.5
    "js/settings/pages.js",              # Task 5.1
    "js/settings/integrations.js",       # Task 6.3
    "js/settings/notifications.js",      # Task 6.5
}


def referenced_js():
    """Every /static/js/... file the frame loads, the template modules included,
    less the shared shell scripts."""
    h = (STATIC / FRAME).read_text(encoding="utf-8")
    return sorted(set(re.findall(r'\bsrc="/static/(js/[^"?]+\.js)[?"]', h)) - SHELL_JS)


def kit_code() -> str:
    """kit.js with comments removed and string contents blanked, so a pin is
    only met by live code (a comment naming the fix does not count)."""
    return js_code_only((STATIC / "js" / "settings" / "kit.js").read_text(encoding="utf-8"))


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
        for token in ("--ws-status-ok", "--ws-status-warn", "--ws-status-err", ".ws-light-ok",
                      ".ws-light-warn", ".ws-light-error", ".ws-light-unconfigured", ".ws-invalid",
                      ".ws-switch", ".ws-tab", ".ws-savebar", ".ws-admin-only"):
            self.assertIn(token, css)

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
        for name in ("boot", "registerTab", "go", "metaFor", "card", "leave"):
            self.assertRegex(js, rf"\b{name}: {name}\b", name)
        for method in ("text", "textarea", "toggle", "select", "color", "iconPicker", "secret", "track",
                       "get", "set", "stageDefaults", "onChange", "onSaved", "onDiscard", "beforeSave",
                       "fieldError", "dirtyKeys", "save"):
            self.assertIn(f"api.{method} = function", js, method)
        for event in ("ws-settings:saved", "ws-settings:discarded", "ws-settings:tab"):
            self.assertIn(event, js)
        self.assertIn("beforeunload", js)
        self.assertIn("/api/admin/settings?view=registry", js)
        self.assertIn("/api/admin/settings/bulk", js)

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
