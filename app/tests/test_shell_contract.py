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
               "books", "book", "books-person", "books-series", "news", "wiki", "settings", "reader", "player-test"]
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
        for i in ("desktopSidebar", "desktopNav", "drawerNav", "drawerOverlay", "drawerPanel",
                  "hamburgerBtn", "drawerCloseBtn", "mobileTopBar", "mobileUserMenuBtn",
                  "mobileUserMenuDropdown", "mobileUsername", "mobileRole", "scrollDownHint",
                  "appVersion"):
            self.assertIn(f'id="{i}"', side, i)
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

if __name__ == "__main__":
    unittest.main()
