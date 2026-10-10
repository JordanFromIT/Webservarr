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
               "books", "books-person", "books-series", "books-stats", "news", "wiki", "settings", "reader",
               "player-test"]
BARE_PAGES = ["login", "setup"]

# The repo is a template; an operator's own branding lives in the database,
# never in these files. Operators can add their own names to the guard without
# committing them: WEBSERVARR_FORBIDDEN_STRINGS="My Server,myserver.example".


def parse_forbidden(raw: str) -> list:
    """Commas, newlines and carriage returns all separate entries (a value pasted
    into a textarea may carry line breaks); each entry is trimmed, blanks dropped.
    CI masks exactly this list in its log (.github/workflows/docker-publish.yml)."""
    return [s.strip() for s in re.split(r"[,\r\n]", raw) if s.strip()]


FORBIDDEN_STRINGS = parse_forbidden(os.environ.get("WEBSERVARR_FORBIDDEN_STRINGS", ""))


def read(name: str) -> str:
    return (STATIC / f"{name}.html").read_text(encoding="utf-8")


UI_JS_TAG = '<script src="/static/js/ui.js?v=1"></script>'
SIDEBAR_MARKER = "<!-- ws:sidebar -->"


def assert_ui_js_before(tc: unittest.TestCase, html: str, later: str) -> None:
    """window.WSUI (ui.js) is ready before `later` in this page: the shell
    partial loads it with a plain blocking tag, the partial fills the sidebar
    marker ahead of `later`, and the page carries no ui.js tag of its own."""
    partial = (STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8")
    tc.assertEqual(partial.count(UI_JS_TAG), 1)
    tc.assertNotIn("/static/js/ui.js", html)
    tc.assertIn(SIDEBAR_MARKER, html)
    tc.assertLess(html.index(SIDEBAR_MARKER), html.index(later))


def js_code_only(src: str, keep_strings: bool = False) -> str:
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

    keep_strings: leave string and template text in place instead (comments
    are still removed, regex bodies still blanked). Character for character
    the same length as the blanked form, so a position in one is the same
    position in the other: text that is blank in one and not in the other is
    inside a string.
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
                out.extend((src[i:i + 2] + " ")[:2] if keep_strings else "  ")
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
                out.append(c if keep_strings else ("\n" if c == "\n" else " "))
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
                body = src[i + 1:j].ljust(j - i - 1) if keep_strings else " " * (j - i - 1)
                out.extend(c + body + c)
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
        for i in ("desktopSidebar", "desktopNav", "mobileTopBar", "wsBarTitle", "wsTabBar", "wsTabList",
                  "wsMoreSheet", "wsMoreTitle", "wsMoreNav", "wsInstallHelp", "scrollDownHint", "appVersion"):
            self.assertIn(f'id="{i}"', side, i)
        # The phone menu, its drawer and the phone account menu are gone:
        # pages live in the tab bar and More, sign-out in More.
        for i in ("drawerNav", "drawerOverlay", "drawerPanel", "hamburgerBtn", "drawerCloseBtn",
                  "mobileUserMenuBtn", "mobileUserMenuDropdown", "mobileUsername", "mobileRole"):
            self.assertNotIn(i, side, i)
        for i in ("appHeader", "systemStatus", "userMenuBtn", "userMenuDropdown",
                  "headerUsername", "headerRole", "headerAvatar"):
            self.assertIn(f'id="{i}"', head, i)
        self.assertNotIn("Loading", head)
        # The router prefetches on hover; the sidebar carries no rules of its own.
        self.assertNotIn("speculationrules", side)

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
        # empty inbox: both reads leave for /login on a 401, through the
        # router when there is one (signIn, WS.leaveTo).
        src = (STATIC / "js" / "notifications.js").read_text(encoding="utf-8")
        for fn in ("fetchUnreadCount", "fetchNotifications"):
            m = re.search(rf"\bfunction {fn}\(\)\s*\{{", src)
            self.assertIsNotNone(m, fn)
            body = src[m.end():matching_brace(src, m.end() - 1)]
            self.assertTrue(live_matches(body, r"\.status\s*===\s*401\)\s*\{\s*signIn\(\);"), fn)
        m = re.search(r"\bfunction signIn\(\)\s*\{", src)
        body = src[m.end():matching_brace(src, m.end() - 1)]
        self.assertTrue(live_matches(body, r"""WS\.leaveTo\(['"]/login['"]\)"""))
        self.assertTrue(live_matches(body, r"""else window\.location\.href\s*=\s*['"]/login['"]"""))

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
        # No script in the page (a soft-navigation page, test_soft_nav): the
        # decision is made before the page is drawn from what the page already
        # knows, by theme-loader.js in <head> on a full load and by the page
        # module on every visit.
        self.assertNotIn("<script", inner)
        loader = (STATIC / "js" / "theme-loader.js").read_text(encoding="utf-8")
        m = re.search(r"\bfunction offer\(key, days\)\s*\{", loader)
        self.assertIsNotNone(m, "theme-loader.js: the offer rule")
        offer = loader[m.end():matching_brace(loader, m.end() - 1)]
        code = js_code_only(offer)
        for needle in ("has_email", "vapid_public_key", "Notification.permission", "localStorage.getItem(key)",
                       "days * 86400000"):
            self.assertIn(needle, code, needle)
        self.assertTrue(live_matches(offer, r"""Notification\.permission\s*!==\s*['"]default['"]"""))
        self.assertIn("window.WSPushOffer = offer;", loader)
        # A full load of Home marks <html>, with the card's own key and days,
        # and the mark shows the card (and its space-y gap) at the first paint.
        key = re.search(r'data-dismiss-key="([^"]+)"', attrs).group(1)
        days = re.search(r'data-dismiss-days="([^"]+)"', attrs).group(1)
        self.assertIn(f"var DISMISS_KEY = '{key}';", loader)
        self.assertIn(f"var DISMISS_DAYS = {days};", loader)
        self.assertRegex(js_code_only(loader), r"if \(\(window\.WS_DATA \|\| \{\}\)\.page === '     ' && offer\(DISMISS_KEY, DISMISS_DAYS\)\) \{\s*"
                                               r"document\.documentElement\.setAttribute\('               ', ''\);")
        self.assertIn("'data-push-offer'", loader)
        theme = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        self.assertIn("html[data-push-offer] #pushPrompt[hidden] { display: block; margin-bottom: 2rem; }", theme)
        self.assertIn("html[data-home-hide][data-push-offer] #pushPrompt[hidden] { margin-bottom: 0; }", theme)
        # The page module decides again for its visit, before anything it
        # awaits (so before the swapped page is drawn), takes the mark away and
        # has notifications.js wire the card with the visit's signal.
        home = (STATIC / "js" / "pages" / "home.js").read_text(encoding="utf-8")
        mount = home[home.index("export async function mount(ctx) {"):]
        decide = mount.index("card.hidden = !(typeof window.WSPushOffer === 'function' &&")
        self.assertIn("window.WSPushOffer(card.dataset.dismissKey, Number(card.dataset.dismissDays))", mount)
        self.assertLess(decide, mount.index("await "))
        self.assertLess(decide, mount.index("document.documentElement.removeAttribute('data-push-offer');"))
        self.assertIn("if (!card.hidden && typeof window.initPushPrompt === 'function') window.initPushPrompt(card, signal);", mount)
        # Home only.
        for n in SHELL_PAGES:
            if n != "index":
                self.assertNotIn("pushPrompt", read(n), n)
        # notifications.js wires the card it is given (not at its own start:
        # each visit brings a new card) and writes the dismissal to its key.
        src = (STATIC / "js" / "notifications.js").read_text(encoding="utf-8")
        m = re.search(r"\bfunction init\(\)\s*\{", src)
        init = src[m.end():matching_brace(src, m.end() - 1)]
        self.assertFalse(live_matches(init, r"\binitPushPrompt\("), "the page module wires the prompt")
        self.assertTrue(live_matches(src, r"\bfunction initPushPrompt\(card, signal\)"))
        self.assertTrue(live_matches(src, r"window\.initPushPrompt = initPushPrompt;"))
        self.assertFalse(live_matches(src, r"""getElementById\(\s*['"]pushPrompt['"]\s*\)"""))
        m = re.search(r"\bfunction initPushPrompt\(card, signal\)\s*\{", src)
        wiring = src[m.end():matching_brace(src, m.end() - 1)]
        adds = live_matches(wiring, r"\b(\w+)\.addEventListener\(")
        self.assertEqual(sorted(a.group(1) for a in adds), ["enableBtn", "laterBtn"])
        self.assertEqual(len(live_matches(wiring, r"\}, \{ signal: signal \}\);")), 2, "both end with the visit")
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
            "shell.js": r"\bpopClose\(\s*menu\s*\)",
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
        # The message names the string by index only: assertNotIn would print
        # the string and the whole file, and CI logs are public.
        for p in files:
            t = p.read_text(encoding="utf-8")
            for i, bad in enumerate(FORBIDDEN_STRINGS):
                self.assertFalse(
                    bad in t,
                    f"instance-specific string #{i} (from WEBSERVARR_FORBIDDEN_STRINGS) found in {p.name}")
        # Generic guard: every shipped page carries the template's own name.
        for p in STATIC.glob("*.html"):
            m = re.search(r"<title>(.*?)</title>", p.read_text(encoding="utf-8"), re.S)
            self.assertIsNotNone(m, p.name)
            self.assertTrue(m.group(1).strip().startswith("WebServarr - "), f"{p.name}: {m.group(1)!r}")

    def test_forbidden_strings_split_on_commas_and_newlines(self):
        self.assertEqual(parse_forbidden("alpha\nbeta gamma,\r\ndelta,,"), ["alpha", "beta gamma", "delta"])
        self.assertEqual(parse_forbidden(" one , two\n\n"), ["one", "two"])
        self.assertEqual(parse_forbidden(""), [])

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
                     "clearPageCache", "dragScroll", "mediaType", "requestStatus"):
            self.assertRegex(block, rf"\b{name}\s*:\s*{name}\b", name)
        # Pages call this to stop a row's momentum glide before scrolling it.
        self.assertIsNotNone(re.search(r"\bdragScroll\.stop\s*=\s*function\b", code),
                             "dragScroll.stop = function ... not defined (outside comments/strings)")

    def test_clearing_the_page_cache_drops_the_routers_prefetch(self):
        # The router's hover prefetch is the only page cache (the service
        # worker's and the speculation rules are gone): a save or a sign-out
        # drops what it holds, and nothing else.
        code = js_code_only((STATIC / "js" / "shell.js").read_text(encoding="utf-8"))
        m = re.search(r"\bfunction clearPageCache\(\)\s*\{", code)
        self.assertIsNotNone(m)
        body = code[m.end():matching_brace(code, m.end() - 1)]
        self.assertEqual(body.strip(),
                         "if (window.WS && WS.router && WS.router.clearPrefetch) WS.router.clearPrefetch();")
        self.assertNotIn("wireNav", code)

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


def css_rules(css: str, selector: str) -> list:
    """Every declaration block whose selector list names `selector` exactly."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    out = []
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        if selector in [s.strip() for s in m.group(1).split(",")]:
            out.append(m.group(2))
    return out


class PhoneShellContract(unittest.TestCase):
    """Phone navigation and the home-screen app (spec
    2026-10-04-mobile-nav-and-home-screen-design.md)."""

    @classmethod
    def setUpClass(cls):
        strip = lambda text: re.sub(r"<!--.*?-->", "", text, flags=re.S)
        cls.side = strip((STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8"))
        cls.theme = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        cls.shell = (STATIC / "js" / "shell.js").read_text(encoding="utf-8")

    def test_tab_bar_and_sheet_markup(self):
        self.assertRegex(self.side, r'<nav id="wsTabBar" class="ws-tabbar lg:hidden" aria-label="Main">\s*'
                                    r'<ul id="wsTabList" class="ws-tabbar-list">\s*\{\{\{tab_links\}\}\}\s*</ul>\s*</nav>')
        self.assertRegex(self.side, r'<dialog id="wsMoreSheet" class="ws-sheet" aria-labelledby="wsMoreTitle">')
        self.assertRegex(self.side, r'<ul id="wsMoreNav" class="ws-sheet-list">\s*\{\{\{more_links\}\}\}\s*</ul>')
        self.assertRegex(self.side, r'<p id="wsBarTitle"[^>]*>\{\{bar_title\}\}</p>')
        self.assertEqual(self.side.count("data-logout"), 1)
        # The sheet's own close button and the scrim close it.
        self.assertEqual(len(re.findall(r"\bdata-sheet-close\b", self.side)), 2)
        # Only one list of steps shows: a display on the class must not beat
        # the hidden attribute install.js sets on the other.
        self.assertIn(".ws-install-steps[hidden] { display: none; }", self.theme)

    def test_the_bottom_of_the_screen_is_shared(self):
        t = self.theme
        self.assertIn("html { --ws-tabbar-h: 0px; --ws-safe-bottom: env(safe-area-inset-bottom); }", t)
        self.assertRegex(t, r"@media \(max-width: 1023\.98px\) \{\s*html:not\(\[data-shell=\"hidden\"\]\) \{\s*"
                            r"--ws-tabbar-h: calc\(64px \+ env\(safe-area-inset-bottom\)\);\s*--ws-safe-bottom: 0px;")
        self.assertIn("#wsPlayer { position: fixed; left: 0; right: 0; bottom: var(--ws-tabbar-h); z-index: 45; }", t)
        self.assertIn("body { padding-bottom: calc(var(--ws-tabbar-h) + var(--ws-player-h)); }", t)
        self.assertIn("#scrollDownHint { bottom: calc(1.5rem + var(--ws-tabbar-h) + var(--ws-player-h)); }", t)
        self.assertIn(".ws-savebar { bottom: calc(var(--ws-tabbar-h) + var(--ws-player-h));", t)
        # The player bar pads for the home indicator only while no tab bar does.
        self.assertTrue(any("padding-bottom: var(--ws-safe-bottom);" in r for r in css_rules(t, ".wsp-bar")))
        # Above the player bar, under the full player (z 80), the dialogs and the toasts.
        self.assertTrue(any("z-index: 46;" in r for r in css_rules(t, ".ws-tabbar")))
        # A full-screen view (the reader) has no tab bar.
        self.assertTrue(css_rules(t, 'html[data-shell="hidden"] #wsTabBar'))

    def test_the_tab_bar_wears_the_shared_frost(self):
        # On trial: the frost's own tokens, so the blur setting and the
        # palette move it with every other frosted surface (the glass has no
        # floor, so the 70% labels lose contrast over a bright poster). Docked
        # to the bottom edge, it takes the slab turned over: the ring as a line
        # along its top edge and the shadow mirrored upward.
        bar = "".join(css_rules(self.theme, ".ws-tabbar"))
        self.assertIn("background: var(--ws-frost-ring-bar-layer), linear-gradient(var(--ws-frost-tint), var(--ws-frost-tint)), "
                      "rgb(var(--color-background) / var(--ws-frost-floor));", bar)
        self.assertIn("backdrop-filter: var(--ws-frost-blur) var(--ws-frost-boost);", bar)
        self.assertIn("border-top: 1px solid var(--ws-frost-edge);", bar)
        self.assertIn("box-shadow: var(--ws-frost-shadow-up);", bar)
        self.assertIn("color: rgb(var(--color-text) / .7);", bar)

    def test_sheet_motion_respects_reduced_motion(self):
        m = re.search(r"@media \(prefers-reduced-motion: reduce\) \{(?P<body>(?:[^{}]*\{[^{}]*\})*)\s*\}", self.theme[
            self.theme.index("/* ---- Phone navigation"):])
        self.assertIsNotNone(m, "a reduced-motion block in the phone navigation section")
        self.assertIn(".ws-sheet-panel", m.group("body"))
        self.assertIn("transform: none", m.group("body"))

    def test_shell_js_wires_the_sheet_not_a_drawer(self):
        code = js_code_only(self.shell)
        for gone in ("drawerOverlay", "drawerPanel", "hamburgerBtn", "mobileUserMenuBtn"):
            self.assertNotIn(gone, self.shell, gone)
        m = re.search(r"\bfunction wireSheet\(\)\s*\{", code)
        self.assertIsNotNone(m, "wireSheet()")
        body = code[m.end():matching_brace(code, m.end() - 1)]
        self.assertIn(".showModal()", body)
        self.assertRegex(body, r"addEventListener\('      ', function \(e\) \{\s*e\.preventDefault\(\);")   # cancel: Escape, Back
        self.assertIn("touchmove", self.shell)                                                          # swipe down
        self.assertRegex(code, r"\bfunction closeChrome\(\)\s*\{\s*if \(sheetCloser\) sheetCloser\(\);")
        self.assertRegex(code, r"wireSheet\(\);")

    def test_install_module_is_loaded_and_owned_by_the_shell(self):
        side = (STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8")
        tag = '<script type="module" src="/static/js/install.js?v=1"></script>'
        self.assertEqual(side.count(tag), 1)
        # Before the router: Home's first mount (a dynamic import) finds WS.install.
        self.assertLess(side.index(tag), side.index('src="/static/js/router.js?v=1"'))
        leaks = (STATIC / "js" / "debug-leaks.js").read_text(encoding="utf-8")
        for name in ("SHELL_FILES", "SELF_OWNED_FILES"):
            m = re.search(rf"export const {name} = \[([^\]]*)\]", leaks)
            self.assertIn("'install.js'", m.group(1), name)
        self.assertRegex(leaks, r"const SHELL_IDS = \[[^\]]*'wsTabBar'")

    def test_the_player_modules_load_after_the_stylesheets(self):
        # They are not needed for the first paint; at the default priority
        # they took a slow phone's bandwidth from the render-blocking CSS
        # (first paint about 300 ms later on a throttled cold load).
        side = (STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8")
        tags = re.findall(r'<script type="module" src="/static/js/player/[a-z]+\.js\?v=1"[^>]*>', side)
        self.assertEqual(len(tags), 7)
        for tag in tags:
            self.assertIn(' fetchpriority="low"', tag)
        for name in ("install.js", "router.js"):
            self.assertIn(f'<script type="module" src="/static/js/{name}?v=1"></script>', side)

    def test_the_phone_nav_js_tests_run_locally_and_in_ci(self):
        from app.tests.test_theme_engine import repo_file
        for parts in (("package.json",), (".github", "workflows", "docker-publish.yml")):
            for test in ("node app/tests/js/install.mjs", "node app/tests/js/phone_nav.mjs"):
                self.assertIn(test, repo_file(self, *parts), "/".join(parts))

    def test_theme_loader_catches_the_install_prompt_before_anything_paints(self):
        loader = (STATIC / "js" / "theme-loader.js").read_text(encoding="utf-8")
        code = js_code_only(loader)
        self.assertRegex(code, r"window\.addEventListener\('                   ', function \(e\) \{\s*e\.preventDefault\(\);")
        self.assertIn("window.WSInstalled = installed;", loader)
        self.assertIn("window.WSInstallIOS = ios;", loader)

    def test_home_has_no_install_card(self):
        # Removed 2026-10-06: on a phone it took most of the first screen.
        # "Add to home screen" lives in More only, with its iOS steps.
        page = read("index")
        self.assertNotIn("installCard", page)
        self.assertNotIn("data-install", page)
        loader = (STATIC / "js" / "theme-loader.js").read_text(encoding="utf-8")
        for gone in ("WSInstallOffer", "data-install-offer", "ws-install-card-dismissed", "ws-install-prompt-seen"):
            self.assertNotIn(gone, loader, gone)
        self.assertNotIn("installCard", self.theme)
        self.assertNotIn("data-install-offer", self.theme)
        home = (STATIC / "js" / "pages" / "home.js").read_text(encoding="utf-8")
        self.assertNotIn("install", home.lower())
        install = (STATIC / "js" / "install.js").read_text(encoding="utf-8")
        self.assertFalse(live_matches(install, r"\bwireCard\b"))
        # The More row keeps its two pictured iOS steps.
        ol = re.search(r'<ol[^>]*data-install-steps="ios"[^>]*>(.*?)</ol>', self.side, re.S)
        self.assertIsNotNone(ol)
        steps = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", li)).strip()
                 for li in re.findall(r"<li\b[^>]*>(.*?)</li>", ol.group(1), re.S)]
        self.assertEqual(steps, ["1 Tap ios_share Share in the browser toolbar", "2 Tap Add to Home Screen"])

    def test_home_push_prompt_is_one_slim_line(self):
        page = read("index")
        m = re.search(r"<section\b([^>]*)\bid=\"pushPrompt\"([^>]*)>(.*?)</section>", page, re.S)
        inner = m.group(3)
        # The first thing on Home, on every width (no lg/sm layout switch).
        stack = page.index("data-home-stack>")
        self.assertEqual(page.index("<section", stack), m.start())
        row = re.search(r'<div class="([^"]*)">', inner).group(1).split()
        for c in ("flex", "items-center", "min-h-12", "py-1.5"):
            self.assertIn(c, row, c)
        self.assertFalse([c for c in row if "flex-col" in c or c.startswith("lg:p")], row)
        self.assertIn('<p id="pushPromptTitle"', inner)
        self.assertNotIn("We'll send an alert", inner)
        later = re.search(r"<button\b[^>]*data-push-prompt-later[^>]*>(.*?)</button>", inner, re.S)
        self.assertIn('aria-label="Not now"', later.group(0))
        self.assertIn('<span class="material-symbols-outlined text-xl" aria-hidden="true">close</span>', later.group(1))
        self.assertIn("size-8", later.group(0), "a 32px target (24px is the floor)")
        self.assertLess(inner.index("data-push-prompt-enable"), inner.index("data-push-prompt-later"))

    def test_the_gauges_fit_a_small_phone(self):
        # The gauges live in the headers, one copy each from one partial:
        # beside the status pill from lg and between the title and the status
        # chip in the phone's top bar. Service Health has no row of its own.
        page = read("index")
        self.assertNotIn("netdataGauges", page)
        self.assertNotIn("netdataGauges", self.theme)
        self.assertNotIn("homeHeaderGauges", page)
        part = (STATIC / "partials" / "shell-gauges.html").read_text(encoding="utf-8")
        tpl = re.search(r'<div data-ws-gauges data-pending class="([^"]*)">', part)
        self.assertIsNotNone(tpl)
        outer = tpl.group(1).split()
        # Shown wherever its header is (each header hides itself), with no
        # height of its own, so neither header grows. In the top bar it takes
        # the room up to the chip; in the header it is its own size.
        for c in ("flex", "h-0", "flex-1", "-mr-3", "lg:flex-none", "lg:mx-0"):
            self.assertIn(c, outer)
        self.assertFalse([c for c in outer if c in ("hidden", "xl:flex", "lg:flex")], outer)
        body = part[part.index("<div data-ws-gauges"):]
        # Below xl a small ring with its reading under it, from xl a larger
        # ring with the reading beside it.
        cell = '<div class="flex flex-col items-center gap-1 xl:flex-row xl:gap-2.5">'
        self.assertEqual(body.count(cell), 3)
        self.assertEqual(body.count('<svg class="size-6 shrink-0 xl:size-9"'), 3)
        # CPU and RAM keep their visible names; the network's is for screen readers below xl.
        self.assertIn('>CPU</p>', body)
        self.assertIn('>RAM</p>', body)
        self.assertRegex(body, r'<p class="sr-only [^"]*xl:not-sr-only">Network</p>')
        for hook in ('data-gauge-ring="cpu"', 'data-gauge-ring="ram"', 'data-gauge-ring="net"',
                     'data-gauge-text="cpu"', 'data-gauge-text="ram"',
                     'data-gauge-net="up"', 'data-gauge-net="down"'):
            self.assertEqual(body.count(hook), 1, hook)
        # No sub-line under any gauge (no thread count, memory size or link speed).
        self.assertNotIn("data-gauge-detail", body)
        # The percentages hold four characters.
        self.assertEqual(len(re.findall(r'data-gauge-text="(?:cpu|ram)" class="min-w-\[4ch\] ', body)), 2)
        # Upload and download share one line and one visible unit, each
        # arrow right against its figure (no gap, no fixed-width figure
        # box), the line holding a minimum width for typical readings, and
        # screen readers hear the unit in full after each.
        net = re.search(r'<p class="([^"]*)">(<span[^>]*>arrow_upward</span>.*?)</p>', body)
        self.assertIsNotNone(net)
        line_classes, line = net.group(1).split(), net.group(2)
        self.assertFalse([c for c in line_classes if c.startswith("gap-")], line_classes)
        self.assertTrue([c for c in line_classes if c.startswith("min-w-[")], line_classes)
        self.assertIn("arrow_downward", line)
        self.assertEqual(line.count("data-gauge-unit "), 1)
        self.assertIn('data-gauge-unit class="ml-1 text-frosted-blue/70" aria-hidden="true">Mbps<', line)
        self.assertEqual(line.count('data-gauge-unit-long class="sr-only">megabits per second<'), 2)
        self.assertEqual(line.count('class="tabular-nums">0<'), 2)
        self.assertNotIn("min-w-[4ch]", line)
        self.assertRegex(line, r'>arrow_upward</span><span class="sr-only">Upload</span><span data-gauge-net="up"')
        self.assertRegex(line, r'>arrow_downward</span><span class="sr-only">Download</span><span data-gauge-net="down"')
        self.assertLess(line.index('>Upload<'), line.index('data-gauge-net="up"'))
        self.assertLess(line.index('>Download<'), line.index('data-gauge-net="down"'))
        # Both headers are the shell's: each partial has the one copy, after
        # the pill and after the top bar's title, filled by app/pages.py.
        header = (STATIC / "partials" / "shell-header.html").read_text(encoding="utf-8")
        self.assertEqual(header.count("{{{gauges_html}}}"), 1)
        self.assertLess(header.index('id="systemStatus"'), header.index("{{{gauges_html}}}"))
        self.assertLess(header.index("{{{gauges_html}}}"), header.index('title="Notifications"', header.index("-->")))
        self.assertEqual(self.side.count("{{{gauges_html}}}"), 1)
        self.assertLess(self.side.index('id="wsBarTitle"'), self.side.index("{{{gauges_html}}}"))
        self.assertLess(self.side.index("{{{gauges_html}}}"), self.side.index('id="wsStatusChip"'))
        # The network figures are whole numbers; every reading goes to both.
        gauges = (STATIC / "js" / "gauges.js").read_text(encoding="utf-8")
        self.assertIn("""setText('[data-gauge-net="down"]', String(Math.round(dl)));""", gauges)
        self.assertIn("""setText('[data-gauge-net="up"]', String(Math.round(ul)));""", gauges)
        self.assertIn("doc.querySelectorAll('[data-ws-gauges] ' + selector)", gauges)
        self.assertNotIn("toFixed", gauges)
        self.assertNotIn("data-gauge-detail", gauges)
        # Hidden without Netdata; their room held, nothing painted, until the
        # first reading.
        self.assertIn("html:not([data-netdata]) [data-ws-gauges] { display: none; }", self.theme)
        self.assertIn("[data-ws-gauges][data-pending] { visibility: hidden; }", self.theme)
        # The top bar's room is made on every page with Netdata, not Home only.
        self.assertNotIn('html[data-page="index"][data-netdata]', self.theme)
        self.assertIn("html[data-netdata] .ws-status-chip-word { display: none; }", self.theme)
        self.assertIn("#mobileTopBar [data-ws-gauges] { column-gap: 12px; }", self.theme)


class SharedLiveParts(unittest.TestCase):
    """The headers' gauges and the event log are the shell's, like the nav:
    one partial each, rendered into every shell page by app/pages.py, and one
    shell module each for the life of the document (js/gauges.js,
    js/event-log.js), so no page builds, mounts or polls its own copy."""

    side = (STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8")

    def test_every_shell_page_but_the_reader_carries_the_event_log(self):
        marker = "<!-- ws:event-log -->"
        for name in SHELL_PAGES:
            with self.subTest(name):
                want = 0 if name == "reader" else 1
                self.assertEqual(read(name).count(marker), want)
        for name in BARE_PAGES:
            with self.subTest(name):
                self.assertNotIn(marker, read(name))
                self.assertNotIn("<!-- ws:header -->", read(name))
                self.assertNotIn("<!-- ws:sidebar -->", read(name))

    def test_the_marker_opens_the_pages_content(self):
        # Inside #wsPage, the first thing in its content box: nothing but
        # comments between the box's opening tag and the marker.
        for name in SHELL_PAGES:
            if name == "reader":
                continue
            with self.subTest(name):
                page = read(name)
                at = page.index("<!-- ws:event-log -->")
                self.assertLess(page.index('id="wsPage"'), at)
                before = re.sub(r"<!--.*?-->", "", page[:at], flags=re.S).rstrip()
                self.assertRegex(before, r"<div\b[^>]*>$")

    def test_one_module_each_before_the_router(self):
        router = self.side.index('src="/static/js/router.js?v=1"')
        for name in ("event-log.js", "gauges.js"):
            with self.subTest(name):
                tag = f'<script type="module" src="/static/js/{name}?v=1"></script>'
                self.assertEqual(self.side.count(tag), 1)
                self.assertLess(self.side.index(tag), router)
                for page in SHELL_PAGES + BARE_PAGES:
                    self.assertNotIn(f"/static/js/{name}", read(page), page)
        leaks = (STATIC / "js" / "debug-leaks.js").read_text(encoding="utf-8")
        for name in ("SHELL_FILES", "SELF_OWNED_FILES"):
            m = re.search(rf"export const {name} = \[([^\]]*)\]", leaks)
            self.assertIn("'event-log.js'", m.group(1), name)
            self.assertIn("'gauges.js'", m.group(1), name)

    def test_the_modules_start_once_for_the_document(self):
        log = (STATIC / "js" / "event-log.js").read_text(encoding="utf-8")
        self.assertIn("if (typeof window !== 'undefined' && window.WS && !window.WS.eventLog) {", log)
        self.assertEqual(len(re.findall(r"\bWS\.poll\(", js_code_only(log))), 1)
        self.assertIn("WS.poll(tick, POLL_MS, env.signal);", log)
        gauges = (STATIC / "js" / "gauges.js").read_text(encoding="utf-8")
        self.assertIn("if (typeof window !== 'undefined' && window.WS && !window.WS.gauges) {", gauges)
        self.assertEqual(len(re.findall(r"\bWS\.poll\(", js_code_only(gauges))), 1)

    def test_a_swap_hands_the_new_page_to_the_live_log(self):
        router = js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8"), keep_strings=True)
        swap = router[router.index("function swapDom(doc, page) {"):]
        swap = swap[:swap.index("\n  }\n")]
        self.assertRegex(swap, r"old\.replaceWith\(fresh\);\s*"
                               r"window\.dispatchEvent\(new CustomEvent\('ws:swap', \{ detail: \{ root: fresh \} \}\)\);")
        log = (STATIC / "js" / "event-log.js").read_text(encoding="utf-8")
        self.assertIn("env.target.addEventListener('ws:swap', function (e) { adopt(e.detail && e.detail.root); },", log)
        self.assertIn("if (copy !== section) copy.replaceWith(section);", log)

    def test_no_page_module_owns_them(self):
        for p in sorted((STATIC / "js" / "pages").glob("*.js")):
            with self.subTest(p.name):
                src = p.read_text(encoding="utf-8")
                for gone in ("system-stats", "status/feed", "createEventLog", "data-ws-gauges", "wsEventLog",
                             "data-home-gauges", "homeEventLog"):
                    self.assertNotIn(gone, src)


if __name__ == "__main__":
    unittest.main()
