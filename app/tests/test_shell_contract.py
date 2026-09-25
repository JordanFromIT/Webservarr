"""
Static contract checks on the page files and shell partials.

The shell is server-rendered from two partials; every app page carries the
two markers and nothing of the old JS-built shell. These guards catch the
regression class where one page is edited and drifts from the rest.
"""
import os
import re
import unittest
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "static"
SHELL_PAGES = ["index", "requests", "requests-embed", "issues", "calendar", "tickets",
               "library", "news", "wiki", "settings", "settings-next"]
BARE_PAGES = ["login", "setup", "reader"]

# The repo is a template; an operator's own branding lives in the database,
# never in these files. Operators can add their own names to the guard without
# committing them: WEBSERVARR_FORBIDDEN_STRINGS="My Server,myserver.example".
FORBIDDEN_STRINGS = [s for s in os.environ.get("WEBSERVARR_FORBIDDEN_STRINGS", "").split(",") if s.strip()]


def read(name: str) -> str:
    return (STATIC / f"{name}.html").read_text(encoding="utf-8")


def js_code_only(src: str) -> str:
    """JavaScript source with comments removed and string contents blanked.

    A small scanner rather than a regex, so a // or /* inside a string (a URL,
    say) is not taken for a comment. Blanking the strings means a name that
    appears only inside quotes cannot satisfy a check either.

    Handles the cases a naive scanner gets wrong:
    - template literals: the text is blanked, but ${ ... } expressions stay
      code, tracked by brace depth, so a nested `...` inside one cannot close
      the outer literal early;
    - regex literals: a / where an operand is expected (after an operator,
      an opening bracket, a comma or semicolon, or a keyword such as return)
      starts a regex, whose body - including any quotes, as in /[&<>"']/g -
      is blanked like a string. A / after a name, number or closing bracket
      is division.
    """
    out = []                       # one character per entry
    n = len(src)
    operand_after = set("(,=:[!&|?{};~+-*%<>^")
    operand_keywords = {"return", "typeof", "case", "do", "else", "in", "of", "new", "delete",
                        "void", "throw", "instanceof", "yield", "await"}

    def regex_allowed() -> bool:
        k = len(out) - 1
        while k >= 0 and out[k].isspace():
            k -= 1
        if k < 0:
            return True
        c = out[k]
        # A postfix x++ / x-- completes an operand, so a / after it is
        # division, even though a lone + or - would expect an operand.
        if c in "+-" and k > 0 and out[k - 1] == c:
            return False
        if c in operand_after:
            return True
        if c.isalnum() or c in "_$":
            j = k
            while j >= 0 and (out[j].isalnum() or out[j] in "_$"):
                j -= 1
            return "".join(out[j + 1:k + 1]) in operand_keywords
        return False

    def template(i: int) -> int:
        out.append("`")
        i += 1
        while i < n:
            c = src[i]
            if c == "\\":
                out.extend("  ")
                i += 2
            elif c == "`":
                out.append("`")
                return i + 1
            elif c == "$" and i + 1 < n and src[i + 1] == "{":
                out.extend("${")
                i = code(i + 2, in_template_expr=True)
                if i < n:                          # the } that closes ${
                    out.append("}")
                    i += 1
            else:
                out.append("\n" if c == "\n" else " ")
                i += 1
        return i

    def code(i: int, in_template_expr: bool = False) -> int:
        depth = 0
        while i < n:
            c, nxt = src[i], src[i + 1] if i + 1 < n else ""
            if c == "/" and nxt == "/":
                j = src.find("\n", i)
                i = n if j == -1 else j
            elif c == "/" and nxt == "*":
                j = src.find("*/", i + 2)
                i = n if j == -1 else j + 2
                out.append(" ")
            elif c in "'\"":
                j = i + 1
                while j < n and src[j] != c and src[j] != "\n":
                    j += 2 if src[j] == "\\" else 1
                out.extend(c + " " * (j - i - 1) + c)
                i = j + 1
            elif c == "`":
                i = template(i)
            elif c == "/" and regex_allowed():
                j, in_class = i + 1, False
                while j < n and src[j] != "\n":
                    ch = src[j]
                    if ch == "\\":
                        j += 2
                        continue
                    if ch == "[":
                        in_class = True
                    elif ch == "]":
                        in_class = False
                    elif ch == "/" and not in_class:
                        break
                    j += 1
                j += 1
                while j < n and src[j].isalpha():  # flags
                    j += 1
                out.extend("/" + " " * (j - i - 1))
                i = j
            else:
                if in_template_expr:
                    if c == "{":
                        depth += 1
                    elif c == "}":
                        if depth == 0:
                            return i               # template() consumes it
                        depth -= 1
                out.append(c)
                i += 1
        return i

    code(0)
    return "".join(out)


def matching_brace(code: str, open_at: int) -> int:
    """Index of the } that closes the { at open_at (in comment-free code)."""
    depth = 0
    for i in range(open_at, len(code)):
        if code[i] == "{":
            depth += 1
        elif code[i] == "}":
            depth -= 1
            if depth == 0:
                return i
    raise AssertionError("unbalanced braces")


def live_matches(src: str, pattern: str) -> list:
    """Matches of pattern in raw JS source that are live code.

    js_code_only blanks string contents, so a check on '/login' or 'hidden'
    cannot run on its output directly. Instead each raw match is kept only if
    the code-only form of the source up to it ends with the match itself
    (string contents blanked): a match inside a comment is dropped by the
    stripping, and one inside a string is blanked, so neither survives.
    """
    def blank(text: str) -> str:
        return re.sub(r"""(['"])(.*?)\1""", lambda q: q.group(1) + " " * len(q.group(2)) + q.group(1), text)
    return [m for m in re.finditer(pattern, src)
            if js_code_only(src[:m.end()]).endswith(blank(m.group(0)))]


class ShellContract(unittest.TestCase):
    def test_shell_pages_carry_both_markers_and_no_js_shell(self):
        for n in SHELL_PAGES:
            h = read(n)
            self.assertEqual(h.count("<!-- ws:sidebar -->"), 1, n)
            self.assertEqual(h.count("<!-- ws:header -->"), 1, n)
            for bad in ("sidebar-root", "header-root", "initSidebar(", "showAdminNav(",
                        "loadSystemStatus(", "loadAppVersion(", "/static/js/sidebar.js",
                        "/static/js/header.js", 'id="scrollDownHint"'):
                self.assertNotIn(bad, h, f"{n}: {bad}")
            self.assertIn("/static/js/shell.js", h, n)
            # auth.js defines checkAuth/escapeHtml; shell.js reads WS_DATA from theme-loader.
            self.assertLess(h.index("/static/js/auth.js"), h.index("/static/js/shell.js"), n)
            self.assertLess(h.index("<title>"), h.index("theme-loader.js"), n)

    def test_bare_pages_do_not_reference_the_shell(self):
        for n in BARE_PAGES:
            h = read(n)
            self.assertNotIn("ws:sidebar", h, n)
            self.assertNotIn("ws:header", h, n)
            self.assertNotIn("shell.js", h, n)

    def test_every_page_links_the_compiled_stylesheet_and_theme_loader(self):
        for p in sorted(STATIC.glob("*.html")):
            h = p.read_text(encoding="utf-8")
            self.assertIn('href="/static/css/app.css?v=', h, p.name)
            self.assertIn('src="/static/js/theme-loader.js?v=', h, p.name)

    def test_partials_keep_the_notification_and_menu_contracts(self):
        strip = lambda text: re.sub(r"<!--.*?-->", "", text, flags=re.S)   # comments describe the contract too
        side = strip((STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8"))
        head = strip((STATIC / "partials" / "shell-header.html").read_text(encoding="utf-8"))
        # notifications.js finds bells by title and opens the dropdown in the
        # tapped bell's parent; the mobile bell's parent is the positioned box
        # the panel drops from.
        self.assertEqual(head.count('title="Notifications"'), 1)
        self.assertEqual(side.count('title="Notifications"'), 1)
        self.assertRegex(head, r'<header[^>]*class="[^"]*lg:flex')
        self.assertRegex(side, r'<div class="relative\b[^"]*">\s*<button[^>]*title="Notifications"')
        for i in ("desktopSidebar", "desktopNav", "drawerNav", "drawerOverlay", "drawerPanel",
                  "hamburgerBtn", "drawerCloseBtn", "mobileTopBar", "mobileUserMenuBtn",
                  "mobileUserMenuDropdown", "mobileUsername", "mobileRole", "scrollDownHint",
                  "appVersion"):
            self.assertIn(f'id="{i}"', side, i)
        for i in ("appHeader", "systemStatus", "userMenuBtn", "userMenuDropdown",
                  "headerUsername", "headerRole", "headerAvatar"):
            self.assertIn(f'id="{i}"', head, i)
        self.assertNotIn("Loading", head)
        self.assertIn('type="speculationrules"', side)
        # Prerender/prefetch only nav links, never logout or arbitrary anchors.
        self.assertNotIn('"href_matches"', side)

    def test_notification_dropdown_opens_under_the_tapped_bell(self):
        # Only one bell is visible at a time: below lg the desktop header is
        # display:none. A dropdown fixed to the desktop bell opened inside that
        # hidden header on phones, so tapping the bell showed nothing.
        code = js_code_only((STATIC / "js" / "notifications.js").read_text(encoding="utf-8"))
        self.assertRegex(code, r"\btoggleDropdown\(\s*this\s*\)")
        m = re.search(r"\bfunction openDropdown\(\s*(\w+)\s*\)\s*\{", code)
        self.assertIsNotNone(m, "openDropdown(bell) not found")
        body = code[m.end():matching_brace(code, m.end() - 1)]
        self.assertRegex(body, rf"\banchorDropdown\(\s*{m.group(1)}\s*\)")
        # ...and anchorDropdown really moves the panel into that bell's parent.
        m = re.search(r"\bfunction anchorDropdown\(\s*(\w+)\s*\)\s*\{", code)
        self.assertIsNotNone(m, "anchorDropdown(bell) not found")
        body = code[m.end():matching_brace(code, m.end() - 1)]
        self.assertRegex(body, rf"\b{m.group(1)}\.parentElement\b")
        self.assertRegex(body, r"\.appendChild\(\s*_dropdown\s*\)")

    def test_notification_fetches_send_a_signed_out_user_to_login(self):
        # A session that ends while the page is open must not read as an
        # empty inbox: both reads leave for /login on a 401.
        src = (STATIC / "js" / "notifications.js").read_text(encoding="utf-8")
        for fn in ("fetchUnreadCount", "fetchNotifications"):
            m = re.search(rf"\bfunction {fn}\(\)\s*\{{", src)
            self.assertIsNotNone(m, fn)
            body = src[m.end():matching_brace(src, m.end() - 1)]
            self.assertTrue(live_matches(body, r"\.status\s*===\s*401\b"), fn)
            self.assertTrue(live_matches(body, r"""window\.location\.href\s*=\s*['"]/login['"]"""), fn)

    def test_preferences_modal_offers_every_server_category(self):
        # A category the server sends but the modal has no toggle for can
        # never be turned off.
        py = (STATIC.parent / "routers" / "notifications.py").read_text(encoding="utf-8")
        m = re.search(r"^NOTIFICATION_CATEGORIES\s*=\s*\(([^)]*)\)", py, re.M)
        self.assertIsNotNone(m, "NOTIFICATION_CATEGORIES not found")
        server = re.findall(r"""['"](\w+)['"]""", m.group(1))
        src = (STATIC / "js" / "notifications.js").read_text(encoding="utf-8")
        lists = live_matches(src, r"""var categories\s*=\s*\[[^\]]*\]""")
        self.assertEqual(len(lists), 1, "the modal's categories list")
        self.assertEqual(re.findall(r"""['"](\w+)['"]""", lists[0].group(0)), server)

    def test_home_push_prompt_contract(self):
        page = read("index")
        m = re.search(r"<section\b([^>]*)\bid=\"pushPrompt\"([^>]*)>(.*?)</section>", page, re.S)
        self.assertIsNotNone(m, "index.html: #pushPrompt section")
        attrs, inner = m.group(1) + m.group(2), m.group(3)
        # Hidden until the inline script decides, and no class on the section:
        # a display utility would override the hidden attribute.
        self.assertRegex(attrs, r"\bhidden\b")
        self.assertNotIn("class=", attrs)
        self.assertIn('data-dismiss-key="ws-push-prompt-dismissed"', attrs)
        self.assertIn('data-dismiss-days="30"', attrs)
        for hook in ("data-push-prompt-enable", "data-push-prompt-later", "data-push-prompt-actions"):
            self.assertIn(hook, inner, hook)
        self.assertRegex(inner, r'<p data-push-prompt-msg[^>]*aria-live="polite"')
        # The decision runs inside the section (a visible sibling would add a
        # space-y gap) and before first paint, from what the page already knows.
        script = re.search(r"<script>(.*?)</script>", inner, re.S)
        self.assertIsNotNone(script, "the deciding script sits inside #pushPrompt")
        code = js_code_only(script.group(1))
        for needle in ("has_email", "vapid_public_key", "Notification.permission", "dataset.dismissKey",
                       "dataset.dismissDays", "card.hidden = false"):
            self.assertIn(needle, code, needle)
        self.assertTrue(live_matches(script.group(1), r"""Notification\.permission\s*!==\s*['"]default['"]"""))
        # Home only.
        for n in SHELL_PAGES:
            if n != "index":
                self.assertNotIn("pushPrompt", read(n), n)
        # notifications.js wires that card and writes the dismissal to its key.
        src = (STATIC / "js" / "notifications.js").read_text(encoding="utf-8")
        m = re.search(r"\bfunction init\(\)\s*\{", src)
        init = src[m.end():matching_brace(src, m.end() - 1)]
        self.assertTrue(live_matches(init, r"\binitPushPrompt\(\s*\)"), "init() wires the prompt")
        self.assertTrue(live_matches(src, r"""getElementById\(\s*['"]pushPrompt['"]\s*\)"""))
        self.assertTrue(live_matches(src, r"localStorage\.setItem\(\s*card\.dataset\.dismissKey\b"))
        for hook in ("data-push-prompt-enable", "data-push-prompt-later", "data-push-prompt-msg",
                     "data-push-prompt-actions"):
            self.assertTrue(live_matches(src, rf"""querySelector\(\s*['"]\[{hook}\]['"]\s*\)"""), hook)

    def test_push_stays_off_once_turned_off(self):
        # Push is on by default (a browser that already allows notifications is
        # subscribed quietly), so turning it off must stick on that device.
        src = (STATIC / "js" / "notifications.js").read_text(encoding="utf-8")

        def body_of(fn):
            m = re.search(rf"\bfunction {fn}\([^)]*\)\s*\{{", src)
            self.assertIsNotNone(m, fn)
            return src[m.end():matching_brace(src, m.end() - 1)]

        for fn, patterns in (("disablePush", (r"\bsetPushOff\(\s*true\s*\)",
                                              r"\b_pushDisabling\s*=\s*true\b",
                                              r"\b_pushDisabling\s*=\s*false\b")),
                             ("subscribePush", (r"\bsetPushOff\(\s*false\s*\)",))):
            body = body_of(fn)
            for pattern in patterns:
                self.assertTrue(live_matches(body, pattern), f"{fn}: {pattern}")

        # The re-sync waits for the service worker (seconds) before deciding. The
        # off-checks must run in the callback that has the fresh subscription,
        # after that wait; checked before it, a turn-off made meanwhile is missed.
        sync = body_of("syncPushSubscription")
        cb = live_matches(sync, r"\.getSubscription\(\)\s*\.then\(\s*function\s*\(\s*(\w+)\s*\)\s*\{")
        self.assertEqual(len(cb), 1, "syncPushSubscription: getSubscription().then(function (sub) {...})")
        callback = sync[cb[0].end():matching_brace(sync, cb[0].end() - 1)]
        self.assertTrue(live_matches(callback, r"\bpushTurnedOff\(\s*\)"), "off flag read after the wait")
        self.assertTrue(live_matches(callback, r"\b_pushDisabling\b"), "a turn-off in progress is respected")
        before = sync[:cb[0].start()]
        self.assertFalse(live_matches(before, r"\bpushTurnedOff\(\s*\)"),
                         "the off flag is read before the wait (stale by the time it is used)")

    def test_header_menus_close_each_other(self):
        # The bell and account buttons stop their clicks reaching document, so
        # the menus close each other through a shared ws:menu-open event: each
        # file must announce an opening, and each listener must close its menu.
        closes = {
            "shell.js": r"""\.classList\.add\(\s*['"]hidden['"]\s*\)""",
            "notifications.js": r"\bcloseDropdown\(\s*\)",
        }
        for name, close in closes.items():
            src = (STATIC / "js" / name).read_text(encoding="utf-8")
            self.assertTrue(live_matches(src, r"""\.dispatchEvent\(\s*new CustomEvent\(\s*['"]ws:menu-open['"]"""), name)
            listeners = live_matches(src, r"""\.addEventListener\(\s*['"]ws:menu-open['"]\s*,\s*""")
            self.assertTrue(listeners, f"{name}: no live ws:menu-open listener")
            for lm in listeners:
                rest = src[lm.end():]
                inline = re.match(r"function\s*\w*\s*\(\s*\w*\s*\)\s*\{", rest)
                if inline:
                    body = rest[inline.end():matching_brace(rest, inline.end() - 1)]
                else:
                    ref = re.match(r"(\w+)\s*\)", rest)
                    self.assertIsNotNone(ref, f"{name}: listener is neither inline nor a named function")
                    defs = live_matches(src, rf"\bfunction {ref.group(1)}\s*\(\s*\w*\s*\)\s*\{{")
                    self.assertTrue(defs, f"{name}: {ref.group(1)} not defined")
                    body = src[defs[0].end():matching_brace(src, defs[0].end() - 1)]
                self.assertTrue(live_matches(body, close), f"{name}: ws:menu-open listener closes nothing")

    def test_no_instance_specific_strings(self):
        files = (list(STATIC.glob("*.html")) + list((STATIC / "partials").glob("*.html"))
                 + list((STATIC / "js").glob("*.js")) + list((STATIC / "js" / "settings").glob("*.js")))
        for p in files:
            t = p.read_text(encoding="utf-8")
            for bad in FORBIDDEN_STRINGS:
                self.assertNotIn(bad, t, p.name)
        # Generic guard: every shipped page carries the template's own name.
        for p in STATIC.glob("*.html"):
            m = re.search(r"<title>(.*?)</title>", p.read_text(encoding="utf-8"), re.S)
            self.assertIsNotNone(m, p.name)
            self.assertTrue(m.group(1).strip().startswith("WebServarr - "), f"{p.name}: {m.group(1)!r}")

    def test_polls_go_through_ws_poll(self):
        for n in SHELL_PAGES:
            self.assertNotRegex(read(n), r"\bsetInterval\(", f"{n}: use WS.poll so timers wait for activation")

    def test_shell_js_defines_the_public_api(self):
        code = js_code_only((STATIC / "js" / "shell.js").read_text(encoding="utf-8"))
        # Only the exports object counts: a name mentioned anywhere else in the
        # file (a comment, a string, a local variable) is not an export.
        m = re.search(r"\bwindow\.WS\s*=\s*\{", code)
        self.assertIsNotNone(m, "window.WS = { ... } not found")
        block = code[m.end():matching_brace(code, m.end() - 1)]
        for name in ("ready", "whenActive", "poll", "setHTML", "arrive", "swr", "serviceStatus", "clearCache",
                     "clearPageCache", "wireNav", "dragScroll", "mediaType", "requestStatus"):
            self.assertRegex(block, rf"\b{name}\s*:\s*{name}\b", name)
        # Pages call this to stop a row's momentum glide before scrolling it.
        self.assertIsNotNone(re.search(r"\bdragScroll\.stop\s*=\s*function\b", code),
                             "dragScroll.stop = function ... not defined (outside comments/strings)")

    def test_nav_wiring_can_run_again(self):
        # The Settings page swaps the nav links after a save and calls
        # WS.wireNav() (kit.js). Boot goes through the same entry point, and a
        # link that is already wired is skipped, so listeners never stack when
        # WS.setHTML left a nav untouched.
        code = js_code_only((STATIC / "js" / "shell.js").read_text(encoding="utf-8"))
        def body(name):
            m = re.search(rf"\bfunction {name}\(\)\s*\{{", code)
            self.assertIsNotNone(m, name)
            return code[m.end():matching_brace(code, m.end() - 1)]
        self.assertIn("wirePrefetch();", body("wireNav"))
        boot = code[code.rindex("ready(function () {"):]
        self.assertIn("wireNav();", boot)
        self.assertNotIn("wirePrefetch();", boot)
        self.assertRegex(body("wirePrefetch"),
                         r"forEach\(function \((\w+)\) \{\s*if \(\1\._wsWired\) return;\s*\1\._wsWired = true;")

    def test_clearing_the_page_cache_refreshes_speculation_rules(self):
        # Pages Chrome prerendered through the speculation rules were rendered
        # before the save (or sign-out) that cleared the page cache. Removing
        # the rules script discards them; a NEW script with the same rules
        # re-arms them (a script element never runs twice), inserted on a later
        # task so Chrome does not fold the removal and the re-add into one
        # unchanged update. Where the browser has no speculation rules it does
        # nothing.
        src = (STATIC / "js" / "shell.js").read_text(encoding="utf-8")
        code = js_code_only(src)
        def body(name):
            m = re.search(rf"\bfunction {name}\(\)\s*\{{", code)
            self.assertIsNotNone(m, name)
            return code[m.end():matching_brace(code, m.end() - 1)]
        from app.tests.test_settings_static import top_level
        self.assertRegex(top_level(body("clearPageCache")), r"(?:^|[;{}])\s*refreshSpeculation\(\);")
        spec = body("refreshSpeculation")
        guard = re.search(r"HTMLScriptElement\.supports\(", spec)
        self.assertIsNotNone(guard, "support check")
        self.assertTrue(live_matches(src, r"HTMLScriptElement\.supports\('speculationrules'\)"))
        removed = re.search(r"\.removeChild\((\w+)\)", spec)
        self.assertIsNotNone(removed, "the old rules script is removed")
        self.assertLess(guard.start(), removed.start())
        later = re.search(r"setTimeout\(function \(\) \{", spec)
        self.assertIsNotNone(later, "re-added on a later task")
        self.assertLess(removed.end(), later.start())
        readd = spec[later.end():matching_brace(spec, later.end() - 1)]
        made = re.search(r"var (\w+) = document\.createElement\(", readd)
        self.assertIsNotNone(made, "a new script element")
        self.assertRegex(readd, rf"\.insertBefore\({made.group(1)}\b")
        self.assertNotRegex(readd, rf"\.(?:insertBefore|appendChild)\({removed.group(1)}\b")

    def test_js_code_only_ignores_comments_and_strings(self):
        # Guards the helper the API test relies on.
        src = ("var a = 1; // b: b\n/* c: c */ var u = 'http://x/*y*/'; "
               "window.WS = { d: d, /* e: e */ f: f };")
        code = js_code_only(src)
        self.assertNotIn("b: b", code)
        self.assertNotIn("c: c", code)
        self.assertNotIn("e: e", code)
        self.assertNotIn("http", code)
        self.assertIn("d: d", code)
        self.assertIn("f: f", code)

    def test_js_code_only_tracks_template_expressions(self):
        # A nested template inside ${ } must not close the outer literal early
        # and leak its text into "code" (a false pass for the API test).
        src = "window.WS = { d: d, debugLabel: `x ${ `dragScroll: dragScroll` } y` };"
        code = js_code_only(src)
        self.assertNotIn("dragScroll: dragScroll", code)
        self.assertIn("d: d", code)
        self.assertIn("};", code)
        # Expression code inside ${ } is still code; the literal text is not.
        code = js_code_only("var s = `text ${ obj.keep } more`; var z = 1;")
        self.assertIn("obj.keep", code)
        self.assertNotIn("text", code)
        self.assertIn("var z = 1;", code)

    def test_js_code_only_blanks_regex_literals(self):
        # A regex holding a quote (the escape helper's shape) must not open a
        # fake string that swallows the rest of the file (a false failure).
        src = "var esc = s.replace(/[&<>\"']/g, f);\nwindow.WS = { e: e };"
        code = js_code_only(src)
        self.assertIn("window.WS = {", code)
        self.assertIn("e: e", code)
        self.assertNotIn("&<>", code)
        # After return, too; and a / after a name is division, not a regex.
        code = js_code_only("function t(){ return /'/.test(x); } var r = a / b; var q = 'z'; var k = 2;")
        self.assertIn(".test(x)", code)
        self.assertIn("var r = a / b;", code)
        self.assertIn("var k = 2;", code)
        self.assertNotIn("'z'", code)

    def test_js_code_only_postfix_then_division(self):
        # After x++ or x-- the / is division. Read as a regex, it would run
        # past the line end and swallow the next line's first word as flags.
        for op in ("++", "--"):
            src = ("var frames = 0;\nfunction tick(dt) { frames" + op + " / dt; }\n"
                   "window.WS = { ready: ready, poll: poll };")
            code = js_code_only(src)
            self.assertIn("frames" + op + " / dt;", code, op)
            self.assertIn("window.WS = { ready: ready, poll: poll };", code, op)

if __name__ == "__main__":
    unittest.main()
