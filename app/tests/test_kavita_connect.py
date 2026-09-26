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


def operand(text: str) -> str:
    """An || operand without whitespace or redundant wrapping parentheses, so
    (triedRecently()) and !(markTry()) compare equal to their plain spelling."""
    op = re.sub(r"\s+", "", text)

    def unwrap(x):
        while x.startswith("(") and matching_paren(x, 0) == len(x) - 1:
            x = x[1:-1]
        return x
    op = unwrap(op)
    if op.startswith("!"):
        op = "!" + unwrap(op[1:])
    return op


def raw_call_args(src: str, open_at: int) -> list:
    """Arguments of the call whose ( is at open_at, from raw source: string
    literals are skipped while matching brackets but kept in the result."""
    depth, i, start, args = 0, open_at, open_at + 1, []
    while i < len(src):
        c = src[i]
        if c in "'\"":
            j = i + 1
            while j < len(src) and src[j] != c:
                j += 2 if src[j] == "\\" else 1
            i = j + 1
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
            if depth == 0:
                args.append(src[start:i].strip())
                return args
        elif c == "," and depth == 1:
            args.append(src[start:i].strip())
            start = i + 1
        i += 1
    raise AssertionError("unbalanced call")


# Every Kavita call the reader makes, by what its address says. Foreground
# calls put the book on screen: on a 401 they take over and reconnect.
# Background calls must never interrupt reading. A call that matches neither
# (or both) fails the test, so a new call has to be classified here.
READER_FOREGROUND = {"series-detail": r"^/api/Series/series-detail\?",
                     "book-info": r"^/api/Book//book-info$",
                     "book-page": r"^/api/Book//book-page\?"}
READER_BACKGROUND = {"chapters": r"^/api/Book//chapters$",
                     "get-progress": r"^/api/Reader/get-progress\?",
                     "progress": r"^/api/Reader/progress$",
                     "bookmark": r"^/api/Reader/bookmark$"}


_LITERAL = re.compile(r"'([^']*)'|\"([^\"]*)\"")


def reader_kavita_calls(t, js: str) -> list:
    """(kind, name, args) for every live kavita(...) call in the reader."""
    calls = []
    for m in live_matches(js, r"\bkavita\s*\("):
        if re.search(r"\bfunction\s+$", js[:m.start()]):
            continue                                   # the definition itself
        args = raw_call_args(js, m.end() - 1)
        address = "".join(a or b for a, b in _LITERAL.findall(args[0]))
        kinds = [(kind, name) for kind, table in (("foreground", READER_FOREGROUND),
                                                  ("background", READER_BACKGROUND))
                 for name, pattern in table.items() if re.search(pattern, address)]
        t.assertEqual(len(kinds), 1, f"kavita({args[0]}) is not classified as foreground or background")
        calls.append((kinds[0][0], kinds[0][1], args))
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
    ops = [operand(o) for o in split_top(cond, "||")]
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

def check_page_uses_helper(t, html, retry_id, retry_handler):
    """Both pages: the helper loads first, every 401 goes through it, a
    missing helper never breaks the page or redirects, and Try again is a
    real button wired through it."""
    helper_at = html.find(f'<script src="{HELPER}')
    t.assertNotEqual(helper_at, -1, f"the page does not load {HELPER}")
    # The helper loads before any of the page's own code that calls Kavita or
    # the helper. An inline script that does neither (the eBooks page sets its
    # shelf slots from one before the first paint) may come earlier.
    own = [m for m in re.finditer(r"<script>(.*?)</script>", html, re.S)
           if re.search(r"\bWSKavita\b|\bfunction kavita\s*\(", m.group(1))]
    t.assertTrue(own, "no inline script uses the helper")
    for m in own:
        t.assertLess(helper_at, m.start(), "the page loads the helper after its own code")
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
    t.assertTrue(live_matches(js, rf"""\bel\(\s*['"]{retry_id}['"]\s*\)\.addEventListener\(\s*['"]click['"]\s*,\s*{retry_handler}\s*\)"""),
                 f"#{retry_id} is not wired to {retry_handler}")
    return js


def check_library(t, html):
    js = check_page_uses_helper(t, html, "connectRetry", "retryConnect")
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
    js = check_page_uses_helper(t, html, "errorRetry", "runRetry")

    # A background call on a 401 fails quietly: no takeover, no redirect.
    t.assertTrue(live_matches(js, r"\bfunction kavita\s*\(\s*path\s*,\s*options\s*,\s*background\s*\)"),
                 "kavita() has no background mode")
    kav = body_of(t, js, "kavita")
    quiet = first(t, kav, r"\bif\s*\(\s*background\s*\)\s*throw\b", "a background 401 is not kept quiet")
    t.assertLess(quiet, first(t, kav, r"\breconnectKavita\(\s*\)", "no reconnect"),
                 "a background 401 reconnects before it is kept quiet")
    t.assertFalse(live_matches(kav, r"\bshowError\("), "kavita() takes over the page itself")

    # Every call site is classified; background ones pass background=true,
    # foreground ones (the book, its chapter, book-info, a page) must not,
    # or the reader would sit on "Opening book..." forever.
    seen = set()
    for kind, name, args in reader_kavita_calls(t, js):
        seen.add(name)
        if kind == "background":
            t.assertEqual(args[-1], "true", f"{name}: not called as a background call")
        else:
            t.assertNotEqual(args[-1], "true", f"{name}: a book load is quiet and would hang on the spinner")
    t.assertEqual(seen, set(READER_FOREGROUND) | set(READER_BACKGROUND), "a classified call went missing")
    background = {"saveProgress": body_of(t, js, "saveProgress"),
                  "restoreProgress": body_of(t, js, "restoreProgress"),
                  "loadTOC": body_of(t, js, "loadTOC"),
                  "bookmark": listener_body(t, js, "bookmarkBtn")}
    for name, body in background.items():
        t.assertFalse(live_matches(body, r"\bshowError\("), f"{name}: a background call takes over the page")

    # Never write a position we don't know. Until Kavita confirmed where the
    # reader is (or they turned a page themselves), saveProgress - including
    # the leave-the-page beacon - does nothing.
    t.assertTrue(live_matches(js, r"\bvar\s+positionKnown\s*=\s*false\b"))
    save = body_of(t, js, "saveProgress")
    guard = first(t, save, r"\bif\s*\(\s*!\s*positionKnown\s*\|\|[^)]*\)\s*return\b",
                  "saveProgress writes without a confirmed position")
    t.assertLess(guard, first(t, save, r"\bsendBeacon\(", "no beacon"), "the beacon goes out before the check")
    t.assertLess(guard, first(t, save, r"\bkavita\(", "no save call"), "the save goes out before the check")
    sets = live_matches(js, r"\bpositionKnown\s*=\s*true\b")
    t.assertEqual(len(sets), 2, "positionKnown is confirmed somewhere unexpected")
    restore = body_of(t, js, "restoreProgress")
    t.assertEqual(len(live_matches(restore, r"\bpositionKnown\s*=\s*true\b")), 1,
                  "restoreProgress does not confirm the looked-up position")
    for m in live_matches(restore, r"\.catch\(\s*function\s*\(\s*\w*\s*\)\s*\{"):
        handler = restore[m.end():matching_brace(restore, m.end() - 1)]
        t.assertFalse(live_matches(handler, r"\b(?:positionKnown|lastSaved)\s*="),
                      "a failed lookup is treated as a known position")
    lookup = body_of(t, js, "fetchProgress")
    t.assertTrue(live_matches(lookup, r"\bif\s*\(\s*!\s*r\.ok\s*\)\s*throw\b"),
                 "a failed lookup (500) reads as 'no progress' and opens at page 0 as if known")
    t.assertFalse(live_matches(lookup, r"\br\.ok\s*\?"), "a failed lookup reads as 'no progress'")
    load = body_of(t, js, "loadPage")
    user_turn = live_matches(load, r"\bif\s*\(\s*!\s*skipSave\s*\)\s*\{")
    t.assertTrue(user_turn, "a page the reader turned to is never confirmed")
    block = load[user_turn[0].end():matching_brace(load, user_turn[0].end() - 1)]
    t.assertTrue(live_matches(block, r"\bpositionKnown\s*=\s*true\b"), "a page the reader turned to is never confirmed")

    # Pages turn only while the current page is on screen: not under an error,
    # not before there is a book, and not while a page (or boot's lookup of the
    # saved position) is loading. A turn during boot would confirm the position,
    # and its debounced save could then write boot's fallback page 0 over the
    # reader's real place. It also keeps turns from overlapping.
    can = body_of(t, js, "canTurnPage")
    t.assertTrue(live_matches(can, r"\bbook\.chapterId\s*!=\s*null\b"))
    t.assertTrue(live_matches(can, r"""\bactivePanel\s*===\s*['"]bookContent['"]"""),
                 "pages turn while one is still loading (the boot race)")
    turn = body_of(t, js, "goToPage")
    bail = first(t, turn, r"\bif\s*\(\s*!\s*canTurnPage\(\s*\)\s*\)\s*return\b", "goToPage turns pages without the check")
    t.assertLess(bail, first(t, turn, r"\bloadPage\(\s*page\s*,\s*skipSave\s*\)", "goToPage loads no page"),
                 "goToPage loads before the check")
    t.assertFalse(live_matches(turn, r"\b(?:showPanel|kavita)\s*\("), "goToPage loads a page around the loader")
    # Past the check, a page loads only from goToPage, boot (under the spinner)
    # and a failed page's Try again (under the error). Neither is the reader's
    # input, and both would stall behind the check.
    loads = [m for m in live_matches(js, r"\bloadPage\s*\(") if not re.search(r"\bfunction\s+$", js[:m.start()])]
    t.assertEqual(len(loads), 3, "a page loads past the page-turn check from somewhere unexpected")
    t.assertTrue(live_matches(js, r"\.then\(\s*function\s*\(\s*page\s*\)\s*\{\s*return\s+loadPage\(\s*page\s*,\s*true\s*\)"),
                 "boot's first page waits on the page-turn check and never loads")
    keys = live_matches(js, r"""document\.addEventListener\(\s*['"]keydown['"]\s*,\s*function\s*\(\s*\w+\s*\)\s*\{""")
    t.assertTrue(keys)
    keys = js[keys[0].end():matching_brace(js, keys[0].end() - 1)]
    t.assertEqual(len(live_matches(keys, r"\bgoToPage\(")), len(live_matches(keys, r"\bif\s*\(\s*!\s*canTurnPage\(\s*\)\s*\)\s*return\b")),
                  "a page key turns pages without the check")

    # The three panels are one set: exactly one shows, so a stale error never
    # stays above a working page; the edge zones (outside the panels) go with the error.
    panels = re.search(r"\bvar\s+PANELS\s*=\s*\[([^\]]*)\]", js_code_only(js))
    t.assertIsNotNone(panels, "no PANELS list")
    t.assertEqual(len(split_top(panels.group(1), ",")), 3)
    for panel_id in READER_PANELS:
        t.assertTrue(live_matches(js, rf"""\bvar\s+PANELS\s*=\s*\[[^\]]*['"]{panel_id}['"]"""), panel_id)
    show_panel = body_of(t, js, "showPanel")
    t.assertTrue(live_matches(show_panel, r"""\bvar\s+turning\s*=\s*which\s*!==\s*['"]errorState['"]"""),
                 "the edge zones do not follow the error")
    t.assertTrue(live_matches(show_panel, r"\bactivePanel\s*=\s*which\b"))
    t.assertTrue(live_matches(show_panel, r"\bPANELS\.forEach\("))
    t.assertTrue(live_matches(show_panel, r"""\.classList\.toggle\(\s*['"]hidden['"]\s*,\s*\w+\s*!==\s*\w+\s*\)"""),
                 "showPanel does not hide every panel but the one asked for")
    for zone in ("navPrev", "navNext"):
        t.assertTrue(live_matches(show_panel, rf"""\bel\(\s*['"]{zone}['"]\s*\)\.hidden\s*=\s*!\s*turning\s*;"""),
                     f"#{zone} stays tappable over an error")
    t.assertRegex(html, r"\.nav-zone\[hidden\]\s*\{\s*display:\s*none;?\s*\}",
                  ".nav-zone's display:flex would override [hidden]")
    for fn, panel_id in (("showError", "errorState"), ("renderPage", "bookContent"), ("loadPage", "loading")):
        t.assertTrue(live_matches(body_of(t, js, fn), rf"""\bshowPanel\(\s*['"]{panel_id}['"]\s*\)"""),
                     f"{fn} does not switch to {panel_id} through showPanel")
    t.assertFalse(live_matches(js, r"""\bel\(\s*['"](?:loading|errorState|bookContent)['"]\s*\)\.classList\b"""),
                  "a panel is toggled outside showPanel")
    t.assertFalse(live_matches(body_of(t, js, "renderPage"), r"\.classList\.(?:remove|add)\("),
                  "renderPage shows the book outside showPanel")

    # Try again: the connection problem retries the sign-in; a failed page
    # retries that page (with its own skipSave, so it never confirms an unknown
    # position) straight through the loader, since the page-turn check refuses
    # while the error shows; anything else keeps just "Back to eBooks".
    show_error = body_of(t, js, "showError")
    t.assertTrue(live_matches(show_error, r"\bretryAction\s*=\s*onRetry\b"))
    t.assertTrue(live_matches(show_error, r"""\bel\(\s*['"]errorRetry['"]\s*\)\.classList\.toggle\(\s*['"]hidden['"]\s*,\s*!\s*retryAction\s*\)"""))
    t.assertTrue(live_matches(body_of(t, js, "runRetry"), r"\bretryAction\(\s*\)"))
    t.assertTrue(live_matches(body_of(t, js, "showConnectProblem"),
                              r"\bshowError\(\s*CONNECT_TITLE\s*,\s*CONNECT_MESSAGE\s*,\s*retryConnect\s*\)"))
    failed = live_matches(load, r"\bshowError\(")
    t.assertEqual(len(failed), 1, "loadPage does not explain a failed page (once)")
    retry = raw_call_args(load, failed[0].end() - 1)
    t.assertEqual(len(retry), 3, "a failed page cannot be retried (the arrows are off under an error)")
    t.assertRegex(retry[2], r"^function\s*\(\s*\)\s*\{\s*loadPage\(\s*page\s*,\s*skipSave\s*\)\s*;?\s*\}$",
                  "a failed page's Try again goes through the page-turn check, which refuses under the error")
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
     "el('errorRetry').addEventListener('click', runRetry);", "", check_reader),
    ("reader: connection problem without the sign-in retry", "reader",
     "showError(CONNECT_TITLE, CONNECT_MESSAGE, retryConnect);", "showError(CONNECT_TITLE, CONNECT_MESSAGE);", check_reader),
    ("reader: book-info made background", "reader",
     "return kavita('/api/Book/' + book.chapterId + '/book-info');",
     "return kavita('/api/Book/' + book.chapterId + '/book-info', null, true);", check_reader),
    ("reader: a new unclassified call", "reader",
     "  function loadTOC() {\n",
     "  function loadTOC() {\n    kavita('/api/Reader/something-new', null, true);\n", check_reader),
    ("reader: saveProgress without the confirmed-position check", "reader",
     "if (!positionKnown || current.page === lastSaved) return;",
     "if (current.page === lastSaved) return;", check_reader),
    ("reader: a failed lookup counts as known", "reader",
     "      .catch(function () { return 0; });   // position unknown: open at the start, never save it",
     "      .catch(function () { positionKnown = true; lastSaved = 0; return 0; });", check_reader),
    ("reader: a 500 lookup reads as no progress", "reader",
     "        if (!r.ok) throw new Error('progress HTTP ' + r.status);\n", "", check_reader),
    ("reader: goToPage without the error-panel bail", "reader",
     "    if (!canTurnPage()) return Promise.resolve();\n", "", check_reader),
    ("reader: a page key without the bail", "reader",
     "      if (!canTurnPage()) return;\n      e.preventDefault();\n      goToPage(current.page + 1);",
     "      e.preventDefault();\n      goToPage(current.page + 1);", check_reader),
    ("reader: edge zones stay over the error", "reader",
     "    el('navNext').hidden = !turning;\n", "", check_reader),
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
     "    showPanel('loading');\n    el('loadingText')",
     "    el('bookContent').classList.add('hidden');\n    el('loading').classList.remove('hidden');\n    el('loadingText')",
     check_reader),

    ("reader: pages turn while one loads (the boot race)", "reader",
     "activePanel === 'bookContent'", "activePanel !== 'errorState'", check_reader),
    ("reader: save guard with && for ||", "reader",
     "if (!positionKnown || current.page === lastSaved) return;",
     "if (!positionKnown && current.page === lastSaved) return;", check_reader),
    ("reader: edge zone shown only under the error", "reader",
     "el('navPrev').hidden = !turning;", "el('navPrev').hidden = turning;", check_reader),
    ("reader: a call spelled kavita (", "reader",
     "  function loadTOC() {\n",
     "  function loadTOC() {\n    kavita ('/api/x');\n", check_reader),
    ("reader: a failed page's Try again gated away", "reader",
     "{\n          loadPage(page, skipSave);", "{\n          goToPage(page, skipSave);", check_reader),

    ("library: Try again is a link", "library",
     '<button id="connectRetry" type="button"', '<a id="connectRetry" href="/kavita/connect"', check_library),
    ("library: icon read aloud", "library",
     '<span class="material-symbols-outlined text-4xl text-steel-blue/60" aria-hidden="true">link_off</span>',
     '<span class="material-symbols-outlined text-4xl text-steel-blue/60">link_off</span>', check_library),
    ("library: shelves go on asking", "library",
     "          if (err && err.message === 'reconnecting') throw err;\n", "", check_library),
    ("library: no guard for a missing helper", "library",
     "var connectFailed = !!(window.WSKavita && window.WSKavita.arrivedFromFailedConnect());",
     "var connectFailed = window.WSKavita.arrivedFromFailedConnect();", check_library),
    ("library: retry without the helper guard", "library",
     "    if (!helper || typeof helper.retry !== 'function') {\n      window.location.reload();\n      return;\n    }\n",
     "", check_library),
]


class EquivalentSpellings(unittest.TestCase):
    """The shape check is strict about order, not about spelling."""

    def test_redundant_parentheses_pass(self):
        src = helper_src()
        original = "if (blocked || triedRecently() || !markTry()) {"
        self.assertEqual(src.count(original), 1)
        for spelling in ("if ((blocked) || (triedRecently()) || !(markTry())) {",
                         "if (blocked || ( triedRecently() ) || (!markTry())) {"):
            with self.subTest(spelling):
                check_reconnect(self, src.replace(original, spelling))
        with self.assertRaises(AssertionError):     # still strict about the order
            check_reconnect(self, src.replace(original, "if ((blocked) || (!markTry()) || (triedRecently())) {"))


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


class LibraryShelvesAndGuide(unittest.TestCase):
    """Polish A fix round 1 on the eBooks page: the shelves swap in at once
    into slots reserved per person, and Try again reaches the guide."""

    def setUp(self):
        self.html = page("library")
        self.js = inline_js(self.html)

    def test_try_again_goes_the_way_the_first_load_did(self):
        self.assertTrue(live_matches(self.js, r"el\('retryBtn'\)\.addEventListener\('click', function \(\) \{ "
                                              r"Promise\.all\(\[loadPage\(\), loadShelves\(\)\]\)\.then\(startGuide\); \}\);"))
        self.assertTrue(live_matches(self.js, r"Promise\.all\(\[loadShelves\(\), loadPage\(\)\]\)\.then\(startGuide\);"))
        guide = body_of(self, self.js, "startGuide")
        self.assertTrue(live_matches(guide, r"\['loadingState', 'unavailableState', 'connectState'\]"))

    def test_the_shelves_arrive_in_one_write(self):
        shelves = body_of(self, self.js, "loadShelves")
        self.assertEqual(len(live_matches(shelves, r"\bbox\.replaceChildren\.apply\(box, ")), 1)
        render = body_of(self, self.js, "renderShelf")
        self.assertFalse(live_matches(render, r"appendChild\(section\)|replaceChild\(|el\('shelves'\)"),
                         "a shelf still goes in on its own")
        self.assertTrue(live_matches(render, r"return section;"))

    def test_the_slots_are_the_shelves_this_person_had(self):
        # The plan is per person, and each slot carries its shelf's own title
        # and as many covers as the shelf held.
        titles = dict(re.findall(r"id: '(\w+)', title: '([^']+)'", self.js))
        self.assertEqual(set(titles), {"bookshelf", "recent", "toprated"})
        m = re.search(r"var TITLES = \{ (.*?) \};", self.js)
        self.assertEqual(dict(re.findall(r"(\w+): '([^']+)'", m.group(1))), titles)
        self.assertEqual(len(live_matches(self.js, r"'webservarr_library_shelves:' \+")), 2)   # read by the slots, written by loadShelves
        self.assertEqual(len(live_matches(self.js, r"var SHELF_PLAN_KEY = 'webservarr_library_shelves:' \+")), 1)
        self.assertTrue(live_matches(self.js, r"while \(row\.children\.length > s\[1\]\) row\.removeChild\(row\.lastElementChild\);"))
        self.assertTrue(live_matches(self.js, r"var plan = \[\['recent', 8\]\];"))
        # A slot's covers are the real card's shape, titles included.
        tpl = re.search(r'<template id="shelfSlot">(.*?)</template>', self.html, re.S).group(1)
        self.assertEqual(tpl.count('<p class="mt-2 text-sm leading-snug min-h-[2.75em]">&nbsp;</p>'), 8)
        self.assertTrue(live_matches(self.js, r"'<p class=\"mt-2 text-sm text-frosted-blue leading-snug line-clamp-2 min-h-\[2\.75em\]\">'"))


class LibraryShelvesDontWaitForEachOther(unittest.TestCase):
    """Polish A R126: one hung shelf can't hold back the others. The shelves
    are asked for together, each request gives up, and the swap happens when
    all have answered or at a deadline, whichever is first."""

    def setUp(self):
        self.js = inline_js(page("library"))
        self.shelves = body_of(self, self.js, "loadShelves")

    def test_asked_for_together_not_one_after_another(self):
        self.assertTrue(live_matches(self.shelves, r"var requests = SHELVES\.map\(function \(shelf, i\) \{"))
        self.assertFalse(live_matches(self.shelves, r"\.reduce\("), "the shelves are chained again")
        self.assertEqual(len(re.findall(r"load: function \(signal\) \{", self.js)), 3)
        self.assertEqual(len(re.findall(r"signal: signal\s*\}\);", self.js)), 3)

    def test_each_request_gives_up_and_the_swap_has_a_deadline(self):
        self.assertTrue(live_matches(self.js, r"var SHELF_DEADLINE = 3000, SHELF_TIMEOUT = 8000;"))
        self.assertTrue(live_matches(self.shelves, r"setTimeout\(function \(\) \{ if \(ctl\) ctl\.abort\(\); \}, SHELF_TIMEOUT\)"))
        self.assertTrue(live_matches(self.shelves, r"shelf\.load\(ctl \? ctl\.signal : undefined\)"))
        self.assertTrue(live_matches(self.shelves, r"setTimeout\(done, SHELF_DEADLINE\)"))
        self.assertTrue(live_matches(self.shelves, r"Promise\.race\(\[settled, deadline\]\)"))
        # A failed or timed-out shelf drops out; a late one goes in below.
        self.assertTrue(live_matches(self.shelves, r"results\[i\] = null;"))
        self.assertTrue(live_matches(self.shelves, r"if \(swapped && section && !stopped\) placeLate\(i, section\);"))
        # Nothing goes in once Kavita has said no.
        self.assertTrue(live_matches(self.shelves, r"if \(stopped\) return;"))

    def test_a_late_shelf_takes_its_place_in_shelves_order(self):
        # R129: after the swap a shelf goes in before the first shelf already
        # showing that comes later in SHELVES, else at the end - never in the
        # order the network happened to answer.
        late = body_of(self, self.shelves, "placeLate")
        self.assertTrue(live_matches(late, r"for \(var j = i \+ 1; j < SHELVES\.length; j\+\+\) \{"))
        self.assertTrue(live_matches(late, r"var next = results\[j\] && results\[j\]\.section;"))
        self.assertTrue(live_matches(late, r"if \(next && next\.parentNode === box\) \{ box\.insertBefore\(section, next\); return; \}"))
        self.assertTrue(live_matches(late, r"box\.appendChild\(section\);\s*$"), "no append when nothing later is showing")
        # The only other append-like write in loadShelves is the one swap.
        rest = self.shelves.replace(late, "")
        self.assertFalse(live_matches(rest, r"appendChild\(section\)"), "a late shelf is appended in arrival order again")
        # The model of that rule, in arrival orders the network can produce:
        # the result is always SHELVES order.
        import itertools

        def place(box, i, present):
            for j in range(i + 1, 3):
                if j in present:
                    box.insert(box.index(j), i)
                    return
            box.append(i)
        for arrival in itertools.permutations(range(3)):
            for swapped_with in range(4):          # how many had arrived by the swap
                box = sorted(arrival[:swapped_with])
                present = set(box)
                for i in arrival[swapped_with:]:
                    place(box, i, present)
                    present.add(i)
                self.assertEqual(box, sorted(box), (arrival, swapped_with))

