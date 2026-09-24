"""
eBooks never loops through a failed Kavita sign-in.

A 401 from the Kavita proxy sends the browser to /kavita/connect, which comes
back to /ebooks. When that sign-in fails (/ebooks?kavita=error), or "succeeds"
but the session still does not work, a blind redirect on every 401 turns into
a loop until the rate limit answers with raw JSON. The shared helper
/static/js/kavita-connect.js decides instead: at most one automatic attempt a
minute, none after a reported failure, and a plain message otherwise.

There is no JavaScript runtime in the container, so these pin the control
flow statically, with the scanner from test_shell_contract. Each check is a
function of the source text, so the Mutations class can feed it a broken copy
(patched in memory) and prove the check notices.
"""
import re
import unittest

from app.tests.test_shell_contract import STATIC, js_code_only, live_matches, matching_brace

HELPER = "/static/js/kavita-connect.js"
MESSAGE = "We couldn't connect you to the eBook library right now. Please try again in a few minutes."


def helper_src() -> str:
    path = STATIC / "js" / "kavita-connect.js"
    return path.read_text(encoding="utf-8") if path.exists() else ""


def page(name: str) -> str:
    return (STATIC / f"{name}.html").read_text(encoding="utf-8")


def inline_js(html: str) -> str:
    """The page's own inline scripts (markup text would confuse the scanner)."""
    return "\n".join(re.findall(r"<script>(.*?)</script>", html, re.S))


def body_of(test, src: str, fn: str) -> str:
    found = live_matches(src, rf"\bfunction {fn}\s*\([^)]*\)\s*\{{")
    test.assertTrue(found, f"function {fn} is missing")
    m = found[0]
    return src[m.end():matching_brace(src, m.end() - 1)]


def listener_body(test, src: str, element_id: str) -> str:
    """Body of the inline click listener on el('<element_id>')."""
    found = live_matches(src, rf"""\bel\(\s*['"]{element_id}['"]\s*\)\.addEventListener\(\s*['"]click['"]\s*,\s*function\s*\(\s*\w*\s*\)\s*\{{""")
    test.assertTrue(found, f"no inline click listener on #{element_id}")
    m = found[0]
    return src[m.end():matching_brace(src, m.end() - 1)]


def first(test, src: str, pattern: str, what: str) -> int:
    found = live_matches(src, pattern)
    test.assertTrue(found, what)
    return found[0].start()


def matching_paren(code: str, open_at: int) -> int:
    """Index of the ) that closes the ( at open_at (in code-only text)."""
    depth = 0
    for i in range(open_at, len(code)):
        if code[i] == "(":
            depth += 1
        elif code[i] == ")":
            depth -= 1
            if depth == 0:
                return i
    raise AssertionError("unbalanced parentheses")


def split_top(text: str, sep: str) -> list:
    """Split on sep where it is not nested inside (), [] or {}."""
    parts, depth, start, i = [], 0, 0, 0
    while i < len(text):
        c = text[i]
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif depth == 0 and text.startswith(sep, i):
            parts.append(text[start:i])
            i += len(sep)
            start = i
            continue
        i += 1
    parts.append(text[start:])
    return [p.strip() for p in parts]


def kavita_call_args(test, body: str) -> list:
    """The argument lists of every kavita(...) call in a function body."""
    code = js_code_only(body)
    calls = []
    for m in re.finditer(r"\bkavita\(", code):
        close = matching_paren(code, m.end() - 1)
        calls.append(split_top(code[m.end():close], ","))
    test.assertTrue(calls, "no kavita() call here")
    return calls


# ---------------------------------------------------------------------------
# The helper
# ---------------------------------------------------------------------------

def check_reconnect(t, src):
    """One automatic attempt a minute, and the guard can't be reordered away.

    The guard must be a single if (...) whose || chain asks triedRecently()
    before !markTry(): markTry() records an attempt, so evaluated first (or
    hoisted above the if) it makes triedRecently() true every time and the
    automatic sign-in never runs again."""
    t.assertTrue(live_matches(src, r"\bRETRY_WINDOW_MS\s*=\s*60\s*\*\s*1000\b"))
    t.assertTrue(live_matches(src, r"""\bCONNECT_URL\s*=\s*['"]/kavita/connect['"]"""))
    body = js_code_only(body_of(t, src, "reconnect"))
    guard = None
    for m in re.finditer(r"\bif\s*\(", body):
        close = matching_paren(body, m.end() - 1)
        if re.search(r"\btriedRecently\(", body[m.end():close]):
            guard = (m.start(), close, body[m.end():close])
            break
    t.assertIsNotNone(guard, "reconnect never checks the last attempt in an if (...)")
    start, close, cond = guard
    t.assertNotIn("&&", cond, "the guard must be one || chain")
    ops = split_top(cond, "||")
    t.assertIn("triedRecently()", ops, "triedRecently() is not an operand of the guard")
    t.assertIn("!markTry()", ops, "the attempt is not recorded by the guard itself")
    t.assertLess(ops.index("triedRecently()"), ops.index("!markTry()"),
                 "markTry() runs before triedRecently() and makes it always true")
    t.assertEqual(len(re.findall(r"\bmarkTry\(", body)), 1, "markTry() is called outside the guard")
    t.assertNotRegex(body[:start], r"\bwindow\.location\.href\s*=", "a redirect runs before the guard")
    # The guarded block explains and returns; only after it does the page leave.
    t.assertRegex(body[close:], r"^\)\s*\{", "the guard has no block")
    open_b = body.index("{", close)
    end_b = matching_brace(body, open_b)
    block = body[open_b:end_b]
    t.assertRegex(block, r"\bonProblem\(\s*\)", "the guarded branch never shows the problem")
    t.assertRegex(block, r"\breturn\b", "the guarded branch falls through to the redirect")
    t.assertRegex(block, r"\bblocked\s*=\s*true\b", "later 401s on this page load would go again")
    t.assertRegex(body[end_b:], r"\bwindow\.location\.href\s*=\s*CONNECT_URL\b", "reconnect never leaves")


def check_storage_fallback(t, src):
    body = body_of(t, src, "triedRecently")
    t.assertTrue(live_matches(body, r"\bsessionStorage\.getItem\("))
    t.assertTrue(live_matches(body, r"\bcatch\s*\(\s*\w+\s*\)\s*\{\s*return\s+true\s*;?\s*\}"),
                 "a storage error must count as 'tried recently', never as 'go again'")
    t.assertTrue(live_matches(body, r"\bRETRY_WINDOW_MS\b"))


def check_storage_guarded(t, src):
    # Both scans run on the code-only text: it drops comments, so its
    # offsets differ from the raw source, and a match in it is live code.
    code = js_code_only(src)
    spans = [(m.end() - 1, matching_brace(code, m.end() - 1)) for m in re.finditer(r"\btry\s*\{", code)]
    accesses = list(re.finditer(r"\bsessionStorage\.\w+", code))
    t.assertTrue(accesses)
    for m in accesses:
        t.assertTrue(any(a < m.start() < b for a, b in spans), f"unguarded {m.group(0)} at {m.start()}")


def check_failed_arrival(t, src):
    body = body_of(t, src, "arrivedFromFailedConnect")
    t.assertTrue(live_matches(body, r"\blocation\.search\b"))
    t.assertTrue(live_matches(body, r"""\.get\(\s*['"]kavita['"]\s*\)\s*!==\s*['"]error['"]"""))
    t.assertTrue(live_matches(body, r"""\.delete\(\s*['"]kavita['"]\s*\)"""))
    t.assertTrue(live_matches(body, r"\bhistory\.replaceState\("))
    t.assertTrue(live_matches(body, r"\bblocked\s*=\s*true\b"),
                 "after a reported failure no automatic attempt may follow")


def check_retry(t, src):
    # "Try again" counts as an attempt: if it comes back still broken, the
    # next 401 shows the message instead of going round again.
    body = body_of(t, src, "retry")
    t.assertLess(first(t, body, r"\bmarkTry\(\s*\)", "retry is not recorded"),
                 first(t, body, r"\bwindow\.location\.href\s*=\s*CONNECT_URL\b", "retry goes nowhere"))
    for name in ("reconnect", "retry", "arrivedFromFailedConnect"):
        t.assertTrue(live_matches(src, rf"\bwindow\.WSKavita\s*=\s*\{{[^}}]*\b{name}\s*:"), name)


# ---------------------------------------------------------------------------
# The pages (library.html, reader.html)
# ---------------------------------------------------------------------------

def check_page_uses_helper(t, html, retry_id):
    """Both pages: the helper loads first, every 401 goes through it, a
    missing helper never breaks the page or redirects, and Try again is a
    real button wired through it."""
    helper_at = html.find(f'<script src="{HELPER}')
    t.assertNotEqual(helper_at, -1, f"the page does not load {HELPER}")
    t.assertLess(helper_at, html.find("<script>"), "the page loads the helper after its own code")
    js = inline_js(html)

    kav = body_of(t, js, "kavita")
    t.assertTrue(live_matches(kav, r"\.status\s*===\s*401\b"))
    t.assertTrue(live_matches(kav, r"\breconnectKavita\(\s*\)"), "a 401 bypasses the guard")
    # No page sends the browser to /kavita/connect on its own.
    t.assertFalse(live_matches(js, r"""\blocation\.href\s*=\s*['"]/kavita/connect['"]"""))

    # Without the helper (it failed to load) the page explains and stays put.
    for fn, call, fallback in (("reconnectKavita", r"\bhelper\.reconnect\(\s*showConnectProblem\s*\)",
                                r"\bshowConnectProblem\(\s*\)"),
                               ("retryConnect", r"\bhelper\.retry\(\s*\)", r"\blocation\.reload\(\s*\)")):
        body = js_code_only(body_of(t, js, fn))
        t.assertRegex(body, r"\bvar\s+helper\s*=\s*window\.WSKavita\b", fn)
        m = re.search(r"\bif\s*\(\s*!\s*helper\s*\|\|", body)
        t.assertIsNotNone(m, f"{fn}: no guard for a missing helper")
        open_b = body.index("{", matching_paren(body, body.index("(", m.start())))
        end_b = matching_brace(body, open_b)
        t.assertRegex(body[open_b:end_b], fallback, f"{fn}: a missing helper is not handled")
        t.assertRegex(body[open_b:end_b], r"\breturn\b", f"{fn}: falls through without the helper")
        t.assertRegex(body[end_b:], call, f"{fn}: never uses the helper")
    # Every other use of the helper checks it is there first.
    for m in live_matches(js, r"\bwindow\.WSKavita\.\w+\("):
        line_start = js.rfind("\n", 0, m.start()) + 1
        t.assertIn("window.WSKavita &&", js[line_start:m.start()], f"unguarded {m.group(0)}")

    # Try again: a real button (Space and Enter work), going through the helper.
    t.assertRegex(html, rf'<button id="{retry_id}" type="button"', f"#{retry_id} is not a button")
    t.assertTrue(live_matches(js, rf"""\bel\(\s*['"]{retry_id}['"]\s*\)\.addEventListener\(\s*['"]click['"]\s*,\s*retryConnect\s*\)"""),
                 f"#{retry_id} is not wired to retryConnect")
    return js


def check_library(t, html):
    js = check_page_uses_helper(t, html, "connectRetry")
    # The message lives in the markup, reserved like the other states.
    block = re.search(r'<div id="connectState"[^>]*>.*?</div>', html, re.S)
    t.assertIsNotNone(block, "no #connectState block")
    block = block.group(0)
    t.assertIn(MESSAGE, block)
    t.assertRegex(block, r'<span [^>]*aria-hidden="true"[^>]*>link_off</span>',
                  "the icon is read out as 'link off'")
    t.assertNotRegex(block, r"\b(text|bg|border)-(slate|gray|red|green|amber|yellow|blue)-\d")
    t.assertTrue(live_matches(body_of(t, js, "show"), r"""['"]connectState['"]"""),
                 "show() does not know the connect state")
    t.assertTrue(live_matches(body_of(t, js, "showConnectProblem"), r"""\bshow\(\s*['"]connectState['"]\s*\)"""))
    # A reported failure shows the message and loads nothing (no 401s, no redirect).
    t.assertTrue(live_matches(js, r"\bconnectFailed\s*=\s*!!\(\s*window\.WSKavita\s*&&\s*window\.WSKavita\.arrivedFromFailedConnect\(\s*\)\s*\)"))
    boot = live_matches(js, r"""document\.addEventListener\(\s*['"]DOMContentLoaded['"]\s*,\s*function\s*\(\s*\)\s*\{""")
    loads = [js[m.end():matching_brace(js, m.end() - 1)] for m in boot]
    loads = [b for b in loads if live_matches(b, r"\bloadPage\(\s*\)")]
    t.assertEqual(len(loads), 1, "one boot handler loads the page")
    stop = first(t, loads[0], r"\bif\s*\(\s*connectFailed\s*\)\s*\{[^}]*\bshowConnectProblem\(\s*\)\s*;?\s*return\b",
                 "boot does not stop on a reported failure")
    t.assertLess(stop, first(t, loads[0], r"\bloadShelves\(\s*\)", "no shelves load"))
    t.assertLess(stop, first(t, loads[0], r"\bloadPage\(\s*\)", "no page load"))
    # Once Kavita said no, the remaining shelves must not ask again.
    shelves = body_of(t, js, "loadShelves")
    catches = live_matches(shelves, r"\.catch\(\s*function\s*\(\s*(\w*)\s*\)\s*\{")
    t.assertTrue(catches, "loadShelves has no catch")
    inner = shelves[catches[0].end():matching_brace(shelves, catches[0].end() - 1)]
    err = catches[0].group(1) or "err"
    t.assertTrue(live_matches(inner, rf"""\bif\s*\(\s*{err}\s*&&\s*{err}\.message\s*===\s*['"]reconnecting['"]\s*\)\s*throw\s+{err}\b"""),
                 "a shelf swallows 'reconnecting' and the chain goes on asking")
    t.assertGreaterEqual(len(catches), 2, "the stopped chain needs a final catch (unhandled rejection)")


READER_PANELS = ("loading", "errorState", "bookContent")


def check_reader(t, html):
    js = check_page_uses_helper(t, html, "errorRetry")

    # A background call on a 401 fails quietly: no takeover, no redirect.
    t.assertTrue(live_matches(js, r"\bfunction kavita\s*\(\s*path\s*,\s*options\s*,\s*background\s*\)"),
                 "kavita() has no background mode")
    kav = body_of(t, js, "kavita")
    quiet = first(t, kav, r"\bif\s*\(\s*background\s*\)\s*throw\b", "a background 401 is not kept quiet")
    t.assertLess(quiet, first(t, kav, r"\breconnectKavita\(\s*\)", "no reconnect"),
                 "a background 401 reconnects before it is kept quiet")
    t.assertFalse(live_matches(kav, r"\bshowError\("), "kavita() takes over the page itself")

    # Background calls pass background=true and never call showError; the
    # calls that show the book (book, chapter, page) take over as before.
    background = {"saveProgress": body_of(t, js, "saveProgress"),
                  "restoreProgress": body_of(t, js, "restoreProgress"),
                  "loadTOC": body_of(t, js, "loadTOC"),
                  "bookmark": listener_body(t, js, "bookmarkBtn")}
    for name, body in background.items():
        for args in kavita_call_args(t, body):
            t.assertEqual(args[-1], "true", f"{name}: kavita() is not called as a background call")
        t.assertFalse(live_matches(body, r"\bshowError\("), f"{name}: a background call takes over the page")
    for name in ("resolveChapter", "goToPage"):
        for args in kavita_call_args(t, body_of(t, js, name)):
            t.assertNotEqual(args[-1], "true", f"{name}: a book load is quiet and would hang on the spinner")

    # The three panels are one set: exactly one shows, so a stale error never
    # stays above a working page.
    panels = re.search(r"\bvar\s+PANELS\s*=\s*\[([^\]]*)\]", js_code_only(js))
    t.assertIsNotNone(panels, "no PANELS list")
    t.assertEqual(len(split_top(panels.group(1), ",")), 3)
    for panel_id in READER_PANELS:
        t.assertTrue(live_matches(js, rf"""\bvar\s+PANELS\s*=\s*\[[^\]]*['"]{panel_id}['"]"""), panel_id)
    show_panel = body_of(t, js, "showPanel")
    t.assertTrue(live_matches(show_panel, r"\bPANELS\.forEach\("))
    t.assertTrue(live_matches(show_panel, r"""\.classList\.toggle\(\s*['"]hidden['"]\s*,\s*\w+\s*!==\s*\w+\s*\)"""),
                 "showPanel does not hide every panel but the one asked for")
    for fn, panel_id in (("showError", "errorState"), ("renderPage", "bookContent"), ("goToPage", "loading")):
        t.assertTrue(live_matches(body_of(t, js, fn), rf"""\bshowPanel\(\s*['"]{panel_id}['"]\s*\)"""),
                     f"{fn} does not switch to {panel_id} through showPanel")
    # Nothing else flips a panel on its own.
    t.assertFalse(live_matches(js, r"""\bel\(\s*['"](?:loading|errorState|bookContent)['"]\s*\)\.classList\b"""),
                  "a panel is toggled outside showPanel")
    t.assertFalse(live_matches(body_of(t, js, "renderPage"), r"\.classList\.(?:remove|add)\("),
                  "renderPage shows the book outside showPanel")

    # Try again only for the connection problem; a plain book error keeps just "Back to eBooks".
    show_error = body_of(t, js, "showError")
    t.assertTrue(live_matches(show_error, r"""\bel\(\s*['"]errorRetry['"]\s*\)\.classList\.toggle\(\s*['"]hidden['"]\s*,\s*!\s*canRetry\s*\)"""))
    t.assertTrue(live_matches(body_of(t, js, "showConnectProblem"),
                              r"\bshowError\(\s*CONNECT_TITLE\s*,\s*CONNECT_MESSAGE\s*,\s*true\s*\)"))
    t.assertIn(MESSAGE, js)
    error_block = re.search(r'<div id="errorState".*?<!--', html, re.S)
    t.assertIsNotNone(error_block)
    t.assertRegex(error_block.group(0), r'<button id="errorRetry" type="button" class="hidden ')


# ---------------------------------------------------------------------------
# The real files
# ---------------------------------------------------------------------------

class ConnectHelper(unittest.TestCase):
    def setUp(self):
        self.src = helper_src()
        self.assertTrue(self.src, HELPER + " is missing")

    def test_one_automatic_attempt_a_minute(self):
        check_reconnect(self, self.src)

    def test_unreadable_storage_means_show_the_message(self):
        check_storage_fallback(self, self.src)

    def test_every_storage_access_is_guarded(self):
        check_storage_guarded(self, self.src)

    def test_reported_failure_is_read_once_and_stripped(self):
        check_failed_arrival(self, self.src)

    def test_manual_retry_is_recorded_and_the_api_exists(self):
        check_retry(self, self.src)


class PagesUseTheHelper(unittest.TestCase):
    def test_library_shows_the_problem_and_stops(self):
        check_library(self, page("library"))

    def test_reader_keeps_reading_and_explains_only_when_it_must(self):
        check_reader(self, page("reader"))


# ---------------------------------------------------------------------------
# The checks notice the breakage they exist for
# ---------------------------------------------------------------------------

MUTATIONS = [
    # (name, file, original text, broken text, check)
    ("markTry hoisted above the guard", "helper",
     "if (blocked || triedRecently() || !markTry()) {",
     "var recorded = markTry();\n    if (blocked || triedRecently() || !recorded) {", check_reconnect),
    ("markTry evaluated before triedRecently", "helper",
     "if (blocked || triedRecently() || !markTry()) {",
     "if (blocked || !markTry() || triedRecently()) {", check_reconnect),
    ("an extra markTry before the guard", "helper",
     "    if (blocked || triedRecently() || !markTry()) {",
     "    markTry();\n    if (blocked || triedRecently() || !markTry()) {", check_reconnect),
    ("no guard", "helper",
     "if (blocked || triedRecently() || !markTry()) {", "if (blocked) {", check_reconnect),
    ("storage error means go again", "helper",
     "    } catch (e) {\n      return true;", "    } catch (e) {\n      return false;", check_storage_fallback),
    ("unguarded storage write", "helper",
     "    try {\n      sessionStorage.setItem(LAST_TRY_KEY, String(Date.now()));\n      return true;\n"
     "    } catch (e) {\n      return false;\n    }",
     "    sessionStorage.setItem(LAST_TRY_KEY, String(Date.now()));\n    return true;", check_storage_guarded),

    ("reader: no guard for a missing helper", "reader",
     "    if (!helper || typeof helper.reconnect !== 'function') {\n      showConnectProblem();\n      return;\n    }\n",
     "", check_reader),
    ("reader: Try again not wired", "reader",
     "el('errorRetry').addEventListener('click', retryConnect);", "", check_reader),
    ("reader: Try again is a link", "reader",
     '<button id="errorRetry" type="button"', '<a id="errorRetry" href="/kavita/connect"', check_reader),
    ("reader: progress save takes over on a 401", "reader",
     "    }, true).catch(function () { lastSaved = -1; });",
     "    }).catch(function () { lastSaved = -1; });", check_reader),
    ("reader: bookmark failure takes over", "reader",
     "    }).catch(function () { /* a bookmark is a convenience; reading goes on */ });",
     "    }).catch(function () { showError(CONNECT_TITLE, CONNECT_MESSAGE, true); });", check_reader),
    ("reader: a background 401 reconnects", "reader",
     "        if (background) throw new Error('unauthorized');\n", "", check_reader),
    ("reader: a page is shown outside the panel set", "reader",
     "    showPanel('bookContent');", "    container.classList.remove('hidden');", check_reader),
    ("reader: loading flipped by hand", "reader",
     "    showPanel('loading');", "    el('bookContent').classList.add('hidden');\n    el('loading').classList.remove('hidden');",
     check_reader),

    ("library: Try again is a link", "library",
     '<button id="connectRetry" type="button"', '<a id="connectRetry" href="/kavita/connect"', check_library),
    ("library: icon read aloud", "library",
     '<span class="material-symbols-outlined text-4xl text-steel-blue/60" aria-hidden="true">link_off</span>',
     '<span class="material-symbols-outlined text-4xl text-steel-blue/60">link_off</span>', check_library),
    ("library: shelves go on asking", "library",
     "            if (err && err.message === 'reconnecting') throw err;\n", "", check_library),
    ("library: no guard for a missing helper", "library",
     "var connectFailed = !!(window.WSKavita && window.WSKavita.arrivedFromFailedConnect());",
     "var connectFailed = window.WSKavita.arrivedFromFailedConnect();", check_library),
    ("library: retry without the helper guard", "library",
     "    if (!helper || typeof helper.retry !== 'function') {\n      window.location.reload();\n      return;\n    }\n",
     "", check_library),
]


class Mutations(unittest.TestCase):
    def test_each_check_notices_its_breakage(self):
        sources = {"helper": helper_src(), "reader": page("reader"), "library": page("library")}
        for name, where, original, broken, check in MUTATIONS:
            with self.subTest(name):
                src = sources[where]
                self.assertEqual(src.count(original), 1, f"the text to break is not in {where} exactly once")
                with self.assertRaises(AssertionError):
                    check(self, src.replace(original, broken))


if __name__ == "__main__":
    unittest.main()
