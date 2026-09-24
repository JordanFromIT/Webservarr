"""
eBooks never loops through a failed Kavita sign-in.

A 401 from the Kavita proxy sends the browser to /kavita/connect, which comes
back to /ebooks. When that sign-in fails (/ebooks?kavita=error), or "succeeds"
but the session still does not work, a blind redirect on every 401 turns into
a loop until the rate limit answers with raw JSON. The shared helper
/static/js/kavita-connect.js decides instead: at most one automatic attempt a
minute, none after a reported failure, and a plain message otherwise.

There is no JavaScript runtime in the container, so these pin the control
flow statically, with the scanner from test_shell_contract.
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


def first(test, src: str, pattern: str, what: str) -> int:
    found = live_matches(src, pattern)
    test.assertTrue(found, what)
    return found[0].start()


class ConnectHelper(unittest.TestCase):
    def setUp(self):
        self.src = helper_src()
        self.assertTrue(self.src, HELPER + " is missing")

    def test_one_automatic_attempt_a_minute(self):
        self.assertTrue(live_matches(self.src, r"\bRETRY_WINDOW_MS\s*=\s*60\s*\*\s*1000\b"))
        body = body_of(self, self.src, "reconnect")
        guard = first(self, body, r"\btriedRecently\(\s*\)", "reconnect never checks the last attempt")
        problem = first(self, body, r"\bonProblem\(\s*\)", "reconnect never shows the problem")
        leave = first(self, body, r"\bwindow\.location\.href\s*=\s*CONNECT_URL\b",
                      "reconnect never goes to /kavita/connect")
        self.assertLess(guard, leave, "the redirect happens before the guard")
        self.assertLess(problem, leave, "the guarded branch must end before the redirect")
        # The guarded branch returns, so the redirect cannot also run.
        branch = body[guard:leave]
        self.assertTrue(live_matches(branch, r"\breturn\b"), "the guarded branch falls through to the redirect")
        # The attempt is recorded before leaving, or the next 401 would not know.
        self.assertLess(first(self, body, r"\bmarkTry\(\s*\)", "the attempt is never recorded"), leave)
        # Once a problem is shown, later 401s in the same page load stay put.
        self.assertTrue(live_matches(body, r"\bblocked\b"))
        self.assertTrue(live_matches(self.src, r"""\bCONNECT_URL\s*=\s*['"]/kavita/connect['"]"""))

    def test_unreadable_storage_means_show_the_message(self):
        body = body_of(self, self.src, "triedRecently")
        self.assertTrue(live_matches(body, r"\bsessionStorage\.getItem\("))
        self.assertTrue(live_matches(body, r"\bcatch\s*\(\s*\w+\s*\)\s*\{\s*return\s+true\s*;?\s*\}"),
                        "a storage error must count as 'tried recently', never as 'go again'")
        self.assertTrue(live_matches(body, r"\bRETRY_WINDOW_MS\b"))

    def test_every_storage_access_is_guarded(self):
        code = js_code_only(self.src)
        spans = [(m.end() - 1, matching_brace(code, m.end() - 1)) for m in re.finditer(r"\btry\s*\{", code)]
        accesses = live_matches(self.src, r"\bsessionStorage\.\w+")
        self.assertTrue(accesses)
        for m in accesses:
            self.assertTrue(any(a < m.start() < b for a, b in spans), f"unguarded {m.group(0)} at {m.start()}")

    def test_reported_failure_is_read_once_and_stripped(self):
        body = body_of(self, self.src, "arrivedFromFailedConnect")
        self.assertTrue(live_matches(body, r"\blocation\.search\b"))
        self.assertTrue(live_matches(body, r"""\.get\(\s*['"]kavita['"]\s*\)\s*!==\s*['"]error['"]"""))
        self.assertTrue(live_matches(body, r"""\.delete\(\s*['"]kavita['"]\s*\)"""))
        self.assertTrue(live_matches(body, r"\bhistory\.replaceState\("))
        self.assertTrue(live_matches(body, r"\bblocked\s*=\s*true\b"),
                        "after a reported failure no automatic attempt may follow")

    def test_manual_retry_is_recorded(self):
        # "Try again" counts as an attempt: if it comes back still broken, the
        # next 401 shows the message instead of going round again.
        body = body_of(self, self.src, "retry")
        self.assertLess(first(self, body, r"\bmarkTry\(\s*\)", "retry is not recorded"),
                        first(self, body, r"\bwindow\.location\.href\s*=\s*CONNECT_URL\b", "retry goes nowhere"))

    def test_public_api(self):
        for name in ("reconnect", "retry", "arrivedFromFailedConnect"):
            self.assertTrue(live_matches(self.src, rf"\bwindow\.WSKavita\s*=\s*\{{[^}}]*\b{name}\s*:"), name)


class PagesUseTheHelper(unittest.TestCase):
    def check_page(self, name):
        html = page(name)
        helper_at = html.find(f'<script src="{HELPER}')
        self.assertNotEqual(helper_at, -1, f"{name} does not load {HELPER}")
        self.assertLess(helper_at, html.find("<script>"), f"{name} loads the helper after its own code")
        js = inline_js(html)
        body = body_of(self, js, "kavita")
        self.assertTrue(live_matches(body, r"\.status\s*===\s*401\b"), name)
        self.assertTrue(live_matches(body, r"\bWSKavita\.reconnect\("), f"{name}: a 401 bypasses the guard")
        # No page may send the browser to /kavita/connect on its own.
        self.assertFalse(live_matches(js, r"""\blocation\.href\s*=\s*['"]/kavita/connect['"]"""), name)
        return html, js

    def test_reader(self):
        self.check_page("reader")

    def test_library_shows_the_problem_and_stops(self):
        html, js = self.check_page("library")
        # The message lives in the markup, reserved like the other states.
        block = re.search(r'<div id="connectState"[^>]*>.*?</div>', html, re.S)
        self.assertIsNotNone(block, "no #connectState block")
        self.assertIn(MESSAGE, block.group(0))
        self.assertRegex(block.group(0), r'<a id="connectRetry" href="/kavita/connect"')
        self.assertNotRegex(block.group(0), r"\b(text|bg|border)-(slate|gray|red|green|amber|yellow|blue)-\d")
        self.assertTrue(live_matches(body_of(self, js, "show"), r"""['"]connectState['"]"""),
                        "show() does not know the connect state")
        self.assertTrue(live_matches(body_of(self, js, "showConnectProblem"),
                                     r"""\bshow\(\s*['"]connectState['"]\s*\)"""))
        # A 401 hands the helper the way to show the problem.
        self.assertTrue(live_matches(body_of(self, js, "kavita"), r"\bWSKavita\.reconnect\(\s*showConnectProblem\s*\)"))
        # A reported failure shows the message and loads nothing (no 401s, no redirect).
        self.assertTrue(live_matches(js, r"\bconnectFailed\s*=\s*window\.WSKavita\.arrivedFromFailedConnect\(\s*\)"))
        boot = live_matches(js, r"""document\.addEventListener\(\s*['"]DOMContentLoaded['"]\s*,\s*function\s*\(\s*\)\s*\{""")
        loads = [js[m.end():matching_brace(js, m.end() - 1)] for m in boot]
        loads = [b for b in loads if live_matches(b, r"\bloadPage\(\s*\)")]
        self.assertEqual(len(loads), 1, "one boot handler loads the page")
        stop = first(self, loads[0], r"\bif\s*\(\s*connectFailed\s*\)\s*\{[^}]*\bshowConnectProblem\(\s*\)\s*;?\s*return\b",
                     "boot does not stop on a reported failure")
        self.assertLess(stop, first(self, loads[0], r"\bloadShelves\(\s*\)", "no shelves load"))
        self.assertLess(stop, first(self, loads[0], r"\bloadPage\(\s*\)", "no page load"))
        # "Try again" goes through the helper so the attempt is recorded.
        self.assertTrue(live_matches(js, r"""\bel\(\s*['"]connectRetry['"]\s*\)\.addEventListener\(\s*['"]click['"]"""))
        self.assertTrue(live_matches(js, r"\bWSKavita\.retry\(\s*\)"))


if __name__ == "__main__":
    unittest.main()
