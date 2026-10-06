"""
Soft navigation: the contract every converted page keeps (spec 4.2, 4.3).

A converted page wraps its content in one #wsPage element that names its page
module; the router swaps only that element and runs the module's mount(ctx).
Everything the page does must therefore be undone when its signal aborts, and
nothing may run on its own outside mount. These checks hold each converted
page to that. The list starts empty: each page's conversion appends its name.
"""
import re
import unittest

from app.tests.test_settings_static import function_body
from app.tests.test_shell_contract import STATIC, js_code_only, live_matches, matching_brace, read

# Pages converted to soft navigation, in conversion order.
CONVERTED = ["news", "settings", "calendar", "issues", "tickets", "wiki", "index", "books", "reader",
             "requests", "requests-embed", "player-test", "book", "books-person", "books-series", "books-stats"]

# Loaded once with the shell and never re-run, so a page never declares them.
SHELL_SCRIPTS = {"theme-loader.js", "auth.js", "shell.js", "ui.js", "notifications.js", "router.js"}

# A page whose module is not named after its file (index.html is Home; the
# author/narrator page and the series page are one module).
MODULE_NAMES = {"index": "home", "books-person": "books-list", "books-series": "books-list"}

_SCRIPT_TAG_RE = re.compile(r"<script\b([^>]*)>", re.I)
_TAG_RE = re.compile(r"<[a-zA-Z][^>]*>")
# HTML attribute names are case-insensitive: onClick= runs like onclick=.
_HANDLER_ATTR_RE = re.compile(r"\son[a-z]+\s*=", re.I)
_HANDLER_IN_STRING_RE = re.compile(r"""\bon[a-z]+=\\?["']""", re.I)
_FUNCTION_ARG_RE = re.compile(r"^\s*(?:async\s+)?function\b")


def module_name(name: str) -> str:
    return MODULE_NAMES.get(name, name)


def module_path(name: str):
    return STATIC / "js" / "pages" / f"{module_name(name)}.js"


def module_source(name: str) -> str:
    return module_path(name).read_text(encoding="utf-8")


def attr(attrs: str, key: str):
    m = re.search(r"(?<![\w-])" + key + r'''\s*=\s*["']([^"']*)["']''', attrs, re.I)
    return m.group(1) if m else None


def call_args(code: str, open_at: int) -> list:
    """The top-level arguments of the call whose ( is at open_at, in code-only
    text (strings blanked, so no bracket or comma inside one counts)."""
    args, depth, start = [], 0, open_at + 1
    for i in range(open_at, len(code)):
        c = code[i]
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
            if depth == 0:
                args.append(code[start:i])
                return args
        elif c == "," and depth == 1:
            args.append(code[start:i])
            start = i + 1
    raise AssertionError("unbalanced brackets")


def is_function(arg: str) -> bool:
    """A function expression: `function`, or an arrow (=> outside any bracket)."""
    if _FUNCTION_ARG_RE.match(arg):
        return True
    depth = 0
    for i, c in enumerate(arg):
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == "=" and depth == 0 and arg[i + 1:i + 2] == ">":
            return True
    return False


def has_own_signal(args: list) -> bool:
    """signal is written in the call's own arguments: a nested call's options
    inside the callback's body do not count, nor does a shared options
    variable (the rule is one visible signal per listener)."""
    return any(re.search(r"\bsignal\b", a) for a in args if not is_function(a))


class ConvertedPages(unittest.TestCase):
    def test_converted_pages_have_module_wrapper(self):
        for name in CONVERTED:
            with self.subTest(name):
                h = read(name)
                self.assertEqual(h.count('id="wsPage"'), 1)
                self.assertRegex(
                    h, r'<div id="wsPage" data-ws-module="/static/js/pages/'
                       + re.escape(module_name(name)) + r'\.js\?v=1"')
                self.assertTrue(module_path(name).is_file(), f"{name}: no page module")

    def test_converted_pages_have_no_inline_script(self):
        for name in CONVERTED:
            with self.subTest(name):
                for m in _SCRIPT_TAG_RE.finditer(read(name)):
                    attrs = m.group(1)
                    if attr(attrs, "src"):
                        continue
                    self.assertEqual(attr(attrs, "type"), "application/json",
                                     f"{name}: inline <script{attrs}>")

    def test_converted_pages_have_no_inline_handlers(self):
        for name in CONVERTED:
            with self.subTest(name):
                for tag in _TAG_RE.findall(read(name)):
                    self.assertNotRegex(tag, _HANDLER_ATTR_RE, f"{name}: inline handler in {tag[:80]}")
                # HTML the module builds, inside a string or template literal.
                self.assertNotRegex(module_source(name), _HANDLER_IN_STRING_RE, f"{module_name(name)}.js")

    def test_modules_follow_the_contract(self):
        for name in CONVERTED:
            with self.subTest(name):
                src = module_source(name)
                code = js_code_only(src)
                self.assertNotIn("setInterval(", code, "intervals go through ctx.poll")
                # The event name is a string, which js_code_only blanks: look for it quoted.
                self.assertNotRegex(src, r"""['"`]DOMContentLoaded['"`]""")
                self.assertNotRegex(code, r"\bwindow\.onload\b")
                self.assertRegex(code, r"\bexport\s+(async\s+)?function\s+mount\s*\(")
                for m in re.finditer(r"\baddEventListener\s*\(", code):
                    args = call_args(code, m.end() - 1)
                    self.assertTrue(has_own_signal(args),
                                    f"{module_name(name)}.js: addEventListener without its own signal: "
                                    f"{code[m.start():m.start() + 80]!r}")

    def test_page_helpers_are_declared(self):
        for name in CONVERTED:
            with self.subTest(name):
                for m in _SCRIPT_TAG_RE.finditer(read(name)):
                    src = attr(m.group(1), "src") or ""
                    if not src.startswith("/static/js/"):
                        continue
                    base = src.split("?")[0].rsplit("/", 1)[-1]
                    if base in SHELL_SCRIPTS:
                        continue
                    self.assertRegex(m.group(1), r"\bdata-ws-page-script\b",
                                     f"{name}: {src} is a page helper without data-ws-page-script")

    def test_converted_pages_have_a_heading_to_focus(self):
        # After a soft navigation the router moves focus to #wsPage's first h1
        # (spec 5.2 step 9); a page without one leaves focus on the old link.
        for name in CONVERTED:
            with self.subTest(name):
                h = read(name)
                self.assertIn("<h1", h[h.index('id="wsPage"'):], f"{name}: no h1 inside #wsPage")


class CalendarPage(unittest.TestCase):
    """Calendar's month data is read on the page's signal and refreshed by the
    page's own poll, so neither outlives a visit."""

    def test_every_read_is_on_the_pages_signal(self):
        code = js_code_only(module_source("calendar"))
        self.assertEqual(len(re.findall(r"\bgetJSON\(", code)), 1)
        self.assertEqual(len(re.findall(r"WS\.getJSON\(url, \{ signal: signal \}\)", code)), 1)
        self.assertNotRegex(code, r"(?<![.\w])fetch\(", "every read goes through WS.getJSON")
        on_error = code[code.index("onError:"):]
        self.assertRegex(on_error, r"if \(signal\.aborted \|\| isAbort\(err\)\) return;")

    def test_it_refreshes_through_ctx_poll(self):
        code = js_code_only(module_source("calendar"))
        self.assertIn("ctx.poll(fetchAndRender, REFRESH_MS);", code)
        self.assertNotRegex(code, r"\bWS\.poll\(")

    def test_a_poll_started_on_screen_reads_nothing_at_once(self):
        # WS.poll's catch-up read is for a prerendered page shown late. A
        # soft-navigated page mounts long after the document loaded and has
        # just read its data: an extra read there doubles every visit's fetch.
        body = function_body(js_code_only((STATIC / "js" / "shell.js").read_text(encoding="utf-8")), "poll")
        self.assertIn("var prerendered = !!document.prerendering;", body)
        self.assertLess(body.index("var prerendered"), body.index("whenActive("))
        self.assertIn("if (prerendered && performance.now() - initAt > 10000) fn();", body)
        self.assertEqual(len(re.findall(r"\bfn\(\);", body)), 4,
                         "the tick, the catch-up read, the tab's return and a back/forward-cache restore")


class IssuesPage(unittest.TestCase):
    """Issues reads, posts and refreshes on the page's signal and poll; its
    detail modal is inside #wsPage, so a swap takes it away; the wiki pointer
    helper only defines WikiHook at load and is started from mount."""

    def test_every_request_is_on_the_pages_signal(self):
        code = js_code_only(module_source("issues"))
        self.assertEqual(len(re.findall(r"WS\.getJSON\('[^']*', \{ signal: signal \}\)", code)), 2)
        self.assertEqual(len(re.findall(r"\bgetJSON\(", code)), 2)
        fetches = [m.start() for m in re.finditer(r"(?<![.\w])fetch\(", code)]
        self.assertEqual(len(fetches), 4, "search, the detail, a new issue and a comment")
        for at in fetches:
            self.assertIn("signal: signal", code[at:code.index(");", at)], code[at:at + 60])
        self.assertEqual(code.count("if (signal.aborted || isAbort(error)) return;"), 4)
        self.assertEqual(code.count("if (signal.aborted || isAbort(err)) return;"), 2)

    def test_timers_and_refresh_are_the_pages(self):
        code = js_code_only(module_source("issues"))
        self.assertRegex(code, r"ctx\.poll\(function \(\) \{\s*loadIssueCounts\(\);\s*loadIssues\(\);\s*\}, REFRESH_MS\);")
        self.assertNotRegex(code, r"\bWS\.poll\(")
        self.assertNotRegex(code, r"(?<![.\w])setTimeout\(", "one-off timers go through ctx.setTimeout")
        self.assertEqual(code.count("ctx.setTimeout("), 2, "the search wait and the refresh after a new issue")
        # The first read is the page's own (a poll on screen reads nothing at once).
        self.assertIn("await Promise.all([loadIssueCounts(), loadIssues()]);", code)

    def test_the_modal_is_inside_the_page(self):
        # It stays in #wsPage: a swap brings it and the next swap takes it
        # away, open or not. <main> is no stacking context at rest (the shell's
        # view-transition names are on only during a transition, test_motion
        # ShellNamesOnlyDuringATransition), so from there it covers the phone's
        # top bar and nothing has to move it to <body>.
        h = read("issues")
        page = h[h.index('<div id="wsPage"'):h.index("</main>")]
        self.assertEqual(h.count('id="issueModal"'), 1)
        self.assertIn('id="issueModal"', page)
        code = js_code_only(module_source("issues"))
        self.assertNotIn("document.body.appendChild", code)
        self.assertNotRegex(code, r"\bmodal\.remove\(")

    def test_wiki_hook_defines_only_and_starts_from_mount(self):
        src = (STATIC / "js" / "wiki-hook.js").read_text(encoding="utf-8")
        code = js_code_only(src)
        # Top level: the WikiHook definition and nothing else. Its two pages
        # are page modules now, so the old initWikiHook wrapper is gone.
        self.assertRegex(code, r"^\s*var WikiHook = \(function \(\) \{")
        self.assertRegex(code, r"return \{ init: init \};\s*\}\)\(\);\s*$")
        self.assertNotIn("initWikiHook", code)
        self.assertRegex(code, r"function init\(ctx, options\) \{\s*var el = ctx\.root\.querySelector\(")
        self.assertIn("var branding = ctx && ctx.data && ctx.data.branding;", code)
        self.assertNotIn("addEventListener", code)
        self.assertIn("WikiHook.init(ctx, { container: 'wikiHookIssues', hook: 'issues', "
                      "lead: 'Might this help first?' });", module_source("issues"))


class TicketsPage(unittest.TestCase):
    """Tickets reads, posts and refreshes on the page's signal and poll; its
    three overlays are inside #wsPage, so a swap takes them away open or not;
    the wiki pointers start from mount with the visit's ctx."""

    def test_every_request_is_on_the_pages_signal(self):
        code = js_code_only(module_source("tickets"))
        self.assertEqual(re.findall(r"\bgetJSON\([^)]*\)", code), ["getJSON(url, { signal: signal })"])
        fetches = [m.start() for m in re.finditer(r"(?<![.\w])fetch\(", code)]
        self.assertEqual(len(fetches), 3, "the two forms' POST, the admin's save and delete")
        for at in fetches:
            self.assertIn("signal: signal", ",".join(call_args(code, at + len("fetch"))), code[at:at + 60])
        # A page left mid-request says nothing: every failure path lets an
        # abort pass (read as written: the toast words are strings).
        src = module_source("tickets")
        self.assertEqual(code.count("if (signal.aborted || isAbort(err)) return;"), 3)
        self.assertEqual(src.count("if (e !== TICKETS_OFF && !isAbort(e)) showToast(e.message, 'error');"), 2)
        self.assertEqual(src.count("if (!isAbort(err)) showToast("), 2)

    def test_timers_and_refresh_are_the_pages(self):
        code = js_code_only(module_source("tickets"))
        self.assertIn("_stopRefresh = ctx.poll(function() { loadTickets(); loadCounts(); }, REFRESH_MS);", code)
        self.assertNotRegex(code, r"\bWS\.poll\(")
        self.assertNotRegex(code, r"(?<![.\w])setTimeout\(")
        self.assertTrue(code.rstrip().endswith("await Promise.all([loadTickets(), loadCounts()]);\n}"))

    def test_the_overlays_are_inside_the_page(self):
        h = read("tickets")
        page = h[h.index('<div id="wsPage"'):h.index("</main>")]
        for overlay in ("createModal", "detailModal", "lightbox"):
            self.assertEqual(h.count(f'id="{overlay}"'), 1, overlay)
            self.assertIn(f'id="{overlay}"', page, overlay)
        code = js_code_only(module_source("tickets"))
        self.assertNotIn("document.body.appendChild", code)
        self.assertNotRegex(code, r"\bdocument\.getElementById\(", "lookups stay inside ctx.root")

    def test_the_tab_styles_are_a_page_style(self):
        # Injected by script they would pile up in <head>, one per visit. The
        # chips are theme.css's .ws-filter now (audit 2026-10-04), keyed on
        # aria-pressed, so the page carries no style of its own for them.
        h = read("tickets")
        self.assertIn('class="filter-tab ws-filter"', h)
        theme = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        self.assertIn('.ws-filter[aria-pressed="true"] {', theme)
        self.assertNotIn("createElement('style')", module_source("tickets"))

    def test_wiki_pointers_start_from_mount(self):
        src = module_source("tickets")
        self.assertIn("WikiHook.init(ctx, { container: 'wikiHookTickets', hook: 'tickets', "
                      "lead: 'Before you contact support:' });", src)
        self.assertIn("WikiHook.init(ctx, { container: 'wikiHookPlayback', hook: 'playback', "
                      "lead: 'It may already be answered here:' });", src)


class WikiPage(unittest.TestCase):
    """The wiki moves between its views (index, category, search, article)
    without re-mounting: it claims /wiki URLs through ctx.onNavigate and the
    router owns history, so the module writes none of its own."""

    def test_wiki_module_does_not_push_history(self):
        code = js_code_only(module_source("wiki"))
        self.assertNotIn("pushState(", code)
        self.assertNotIn("replaceState(", code)

    def test_it_claims_its_own_addresses(self):
        code = js_code_only(module_source("wiki"))
        self.assertRegex(function_body(code, "isWikiPath"),
                         r"^\s*return path === '\s*' \|\| path\.startsWith\('\s*'\);\s*$")
        self.assertIn("return path === '/wiki' || path.startsWith('/wiki/');", module_source("wiki"))
        claim = code[code.index("ctx.onNavigate(function (url, how) {"):]
        claim = claim[:matching_brace(claim, claim.index("{"))]
        self.assertRegex(claim, r"if \(!isWikiPath\(url\.pathname\)\) return false;\s*"
                                r"if \(WikiEditor\.holds\(\)\) return false;\s*return render\(url, \{")
        self.assertIn("pop: !!(how && how.pop), scrollY: how && how.scrollY,", claim)
        self.assertRegex(claim, r"return render\(url, \{")
        # Which addresses it draws, so the router never prefetches them
        # (final review M2).
        self.assertRegex(code, r"\}, function \(url\) \{ return isWikiPath\(url\.pathname\); \}\);")

    def test_its_links_go_through_the_router(self):
        # No click listener of its own: an article, category, back or body
        # link is the router's, which offers it to the claim above.
        code = js_code_only(module_source("wiki"))
        self.assertNotRegex(code, r"(?:document|window)\.addEventListener\(")
        self.assertNotIn("preventDefault", function_body(code, "categoryCard"))
        self.assertRegex(function_body(code, "navigate"), r"^\s*return WS\.router\.navigate\(")
        self.assertIn("navigate(term ? '/wiki?q=' + encodeURIComponent(term) : '/wiki');", module_source("wiki"))

    def test_every_read_ends_with_its_view(self):
        code = js_code_only(module_source("wiki"))
        self.assertEqual(re.findall(r"(?<![.\w])fetch\([^)]*\)", code), ["fetch(path, { signal: vs })"])
        calls = [m for m in re.finditer(r"(?<![.\w])api\(", code)
                 if not code[:m.start()].rstrip().endswith("function")]
        self.assertEqual(len(calls), 8, "two each: index, category, search (its fallback), article (its fallback)")
        for m in calls:
            self.assertEqual(call_args(code, m.end() - 1)[-1].strip(), "vs", code[m.start():m.start() + 80])
        view = function_body(code, "newView")
        self.assertIn("if (_view) _view.abort();", view)
        self.assertIn("signal.addEventListener('     ', function () { v.abort(); }, { once: true, signal: v.signal });", view)
        for name in ("renderIndex", "renderCategory", "renderSearch", "renderPage"):
            self.assertIn("var vs = newView();", function_body(code, name), name)

    def test_scroll_and_focus_follow_the_view(self):
        code = js_code_only(module_source("wiki"))
        render = function_body(code, "render")
        self.assertIn("if (!how.first && !how.pop) toTop();", render)
        self.assertIn("if (how.pop) restoreScroll(how.scrollY);", render)
        self.assertIn("if (how.focus) focusHeading(how.from);", render)
        self.assertRegex(code, r"await render\(ctx\.url, \{ first: true, ")

    def test_the_helpers_define_only_and_start_from_mount(self):
        page = module_source("wiki")
        self.assertIn("WikiCategories.init(ctx);", page)
        self.assertIn("WikiEditor.init(ctx, {", page)
        for name, glob in (("wiki-categories.js", "WikiCategories"), ("wiki-editor.js", "WikiEditor")):
            with self.subTest(name):
                code = js_code_only((STATIC / "js" / name).read_text(encoding="utf-8"))
                # Top level: the definition and nothing else.
                self.assertRegex(code, r"^\s*var " + glob + r" = \(function \(\) \{")
                self.assertRegex(code, r"return \{ init: init[^}]*\};\s*\}\)\(\);\s*$")
                self.assertNotIn("DOMContentLoaded", (STATIC / "js" / name).read_text(encoding="utf-8"))
                self.assertIn("function init(ctx", code)
                # Every listener has a signal of its own, but the one on the
                # visit's signal that tidies up when it aborts.
                for m in re.finditer(r"\baddEventListener\s*\(", code):
                    if code[:m.start()].endswith("signal."):
                        continue
                    self.assertTrue(has_own_signal(call_args(code, m.end() - 1)),
                                    f"{name}: {code[m.start() - 20:m.start() + 80]!r}")
                for m in re.finditer(r"(?<![.\w])fetch\(", code):
                    self.assertIn("signal: ", ",".join(call_args(code, m.end() - 1)), f"{name}: {code[m.start():m.start() + 60]!r}")
        cats = js_code_only((STATIC / "js" / "wiki-categories.js").read_text(encoding="utf-8"))
        self.assertIn("var UI = null, el = null, icon = null, cls = null;", cats)
        self.assertNotRegex(cats, r"(?<![.\w])setTimeout\(", "the panel's timers are the visit's (ctx.setTimeout)")
        editor = js_code_only((STATIC / "js" / "wiki-editor.js").read_text(encoding="utf-8"))
        self.assertNotIn("WikiView", editor)
        self.assertNotIn("window.scrollTo", editor)
        self.assertIn("var vs = host.newView();", function_body(editor, "render"))

    def test_the_editor_asks_before_unsaved_text_is_left(self):
        page = js_code_only(module_source("wiki"))
        self.assertIn("ctx.beforeLeave(function () { return WikiEditor.canLeave(); });", page)
        src = (STATIC / "js" / "wiki-editor.js").read_text(encoding="utf-8")
        code = js_code_only(src)
        holds = function_body(code, "holds")
        self.assertIn("if (!s || !s.form || s.closed || s.approved || !s.form.isConnected) return false;", holds)
        self.assertIn("return s.busy || s.uploads > 0 || !!s.restored || fingerprint(s) !== s.baseline;", holds)
        self.assertIn("_session.baseline = fingerprint(_session);", function_body(code, "render"))
        can = function_body(code, "canLeave")
        self.assertRegex(can, r"^\s*if \(!holds\(\)\) return true;")
        self.assertIn("s.asking = window.WSUI.confirm({", can)
        # Leave approves and keeps the text as the draft; nothing is thrown away.
        self.assertRegex(can, r"if \(ok && _session === s\) \{\s*s\.approved = true;\s*flush\(\);\s*\}")
        self.assertNotIn("clearDraft", can)
        init = function_body(code, "init")
        self.assertRegex(init, r"window\.addEventListener\('\s+', function \(e\) \{\s*flush\(\);\s*if \(holds\(\)\) \{ e\.preventDefault\(\); e\.returnValue = '';")
        self.assertIn("'beforeunload'", src)
        self.assertRegex(init, r"window\.addEventListener\('\s+', function \(\) \{\s*if \(_session\) _session\.approved = false;")
        self.assertIn("'ws:nav-stayed'", src)
        self.assertRegex(init, r"signal\.addEventListener\('\s+', function \(\) \{\s*flush\(\);")
        # The admin's own ways out, and a landed save or delete, never ask.
        self.assertRegex(function_body(code, "close"), r"^\s*if \(_session\) _session\.closed = true;")
        self.assertRegex(function_body(code, "save"), r"s\.closed = true;\s*host\.navigate\(")
        self.assertRegex(function_body(code, "remove"), r"s\.closed = true;\s*if \(_session === s && !sig\.aborted\) host\.navigate\(")
        # A mirror reads the session's own form, so a late one never writes an empty draft.
        self.assertRegex(function_body(code, "collect"), r"var f = \(s && s\.form\) \|\| document;")
        self.assertNotIn("document.getElementById('wikiEditTitle')", code.replace(" ", ""))

    def test_router_hands_the_claim_what_it_needs(self):
        code = js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8"))
        go = function_body(code, "visit")
        claim = go[go.index("if (!current.left && current.claim) {"):go.index("if (!current.left && current.guard) {")]
        # The entry being left keeps its scroll before the page redraws.
        self.assertLess(claim.index("if (!opts.pop) saveScroll();"), claim.index("current.claim("))
        self.assertIn("const got = current.claim(new URL(target.href), { pop: !!opts.pop, scrollY: opts.scrollY || 0 });", claim)
        # One history write, and the same URL again replaces.
        self.assertIn("if (!opts.pop) record(target.href, opts.replace || target.href === location.href);", claim)
        self.assertEqual(claim.count("history."), 0)
        self.assertIn("window.dispatchEvent(new CustomEvent('", claim)
        self.assertIn("ws:page-claimed", (STATIC / "js" / "router.js").read_text(encoding="utf-8"))


class WikiFixRound1(unittest.TestCase):
    """Task 9 fix round 1: an image upload belongs to its editor session (E1),
    a reload keeps the last keystrokes (E2), a late answer never paints over a
    newer view (W1), a claimed view gets its title and announcement (W2), a
    scroll restore stops when the view changes (W3), a cold load scrolls to
    its #fragment (W4)."""

    def editor(self):
        return js_code_only((STATIC / "js" / "wiki-editor.js").read_text(encoding="utf-8"))

    def test_an_upload_belongs_to_its_session(self):
        code = self.editor()
        # The upload runs on the editor view's signal, and inserts only into
        # the form of the session it started in, while that is still showing.
        self.assertRegex(function_body(code, "uploadImage"), r"signal: vs \}\);")
        self.assertIn("function uploadImage(file, vs)", code)
        for kind in ("drop", "paste"):
            start = code.index("ta.addEventListener('" + " " * len(kind) + "', async function (e) {")
            body = code[start:matching_brace(code, code.index("{", start))]
            with self.subTest(kind):
                self.assertIn("var s = _session;", body)
                self.assertIn("await uploadImage(", body)
                self.assertIn(", vs);", body)
                self.assertRegex(body, r"if \(vs\.aborted \|\| _session !== s\) return;\s*insertAtCaret\(")
                self.assertIn("insertAtCaret('\\n' + md + '\\n', s);".replace("'\\n'", "'  '"), body)
                self.assertIn("s.uploads += 1;", body)
                self.assertIn("s.uploads -= 1;", body)
        # The textarea is the session's own, never looked up in the document.
        self.assertNotIn("document.getElementById('               ')", code)
        self.assertRegex(function_body(code, "textarea"), r"s = s \|\| _session;\s*return s && s\.form \? s\.form\.querySelector\(")
        self.assertIn("var ta = textarea(s);", function_body(code, "insertAtCaret"))
        self.assertIn("var ta = textarea();", function_body(code, "wrapSelection"))
        # An upload in flight is unsaved work.
        self.assertIn("return s.busy || s.uploads > 0 || !!s.restored || fingerprint(s) !== s.baseline;",
                      function_body(code, "holds"))
        self.assertIn("_session.uploads = 0;", function_body(code, "open"))

    def test_a_reload_keeps_the_last_keystrokes(self):
        init = function_body(self.editor(), "init")
        self.assertRegex(init, r"window\.addEventListener\('\s+', function \(e\) \{\s*flush\(\);\s*if \(holds\(\)\)")
        self.assertRegex(init, r"window\.addEventListener\('\s+', flush, \{ signal: signal \}\);")
        self.assertIn("'pagehide'", (STATIC / "js" / "wiki-editor.js").read_text(encoding="utf-8"))

    def test_a_late_answer_never_paints_over_a_newer_view(self):
        code = js_code_only(module_source("wiki"))
        for name in ("renderCategory", "renderSearch", "renderPage"):
            with self.subTest(name):
                body = function_body(code, name)
                self.assertRegex(body, r"^\s*_gen \+= 1;\s*var gen = _gen;")
                # After the read, before anything is drawn.
                after = body[body.index("} catch (e) {"):]
                after = after[matching_brace(after, after.index("{")):]
                self.assertRegex(after, r"^\s*\}?\s*if \(gen !== _gen \|\| vs\.aborted\) return;")
                self.assertRegex(body, r"if \(gen !== _gen \|\| vs\.aborted \|\| isAbort\(e\) \|\| e\.message === '\s+'\) return;")

    def test_a_claimed_view_gets_its_title_and_announcement(self):
        router = js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8"))
        go = function_body(router, "visit")
        claim = go[go.index("if (!current.left && current.claim) {"):go.index("if (!current.left && current.guard) {")]
        self.assertRegex(claim, r"claimed = got === true \|\| \(!!got && typeof got\.then === '\s{8}'\);")
        self.assertRegex(claim, r"titled\.then\(function \(name\) \{\s*"
                                r"if \(entry\.left \|\| current !== entry \|\| entry\.url !== href \|\| typeof name !== '\s{6}' \|\| !name\) return;\s*"
                                r"document\.title = pageTitle\(name, siteName\(\)\);\s*announce\(document\.title\);")
        self.assertIn("export function pageTitle(name, site)", router)
        self.assertIn("setTitle: function (name) {", router)
        page = js_code_only(module_source("wiki"))
        on = page[page.index("ctx.onNavigate(function (url, how) {"):]
        on = on[:matching_brace(on, on.index("{"))]
        self.assertRegex(on, r"return render\(url, \{")
        self.assertNotIn("return true;", on)
        self.assertRegex(page, r"var name = await render\(ctx\.url, \{ first: true, [^;]*\);\s*if \(name && !signal\.aborted\) ctx\.setTitle\(name\);")
        # render resolves to the drawn view's name, or null once another replaced it.
        render = function_body(page, "render")
        self.assertIn("return drawn.then(function (name) {", render)
        self.assertIn("if (gen !== _gen || signal.aborted) return null;", render)
        for fn, word in (("renderIndex", "return 'Wiki';"), ("renderPage", "return page.title;"),
                         ("renderCategory", "return cat ? cat.name : 'Wiki';"), ("renderSearch", "return 'Search';")):
            self.assertIn(word.replace("'Wiki'", "'    '").replace("'Search'", "'      '"), function_body(page, fn), fn)

    def test_a_scroll_restore_stops_when_the_view_changes(self):
        page = js_code_only(module_source("wiki"))
        body = function_body(page, "restoreScroll")
        self.assertIn("var gen = _gen;", body)
        self.assertIn("if (signal.aborted || gen !== _gen) return;", body)

    def test_a_cold_load_scrolls_to_its_fragment(self):
        router = js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8"))
        boot = router[router.index("const firstPage = document.getElementById("):]
        self.assertRegex(boot, r"return mountPage\(mod, moduleUrl, new URL\(location\.href\)\)\.then\(function \(\) \{\s*"
                               r"restoreScroll\(y, firstToken\);\s*if \(!y\) scrollToHash\(new URL\(location\.href\)\);")


class HomePage(unittest.TestCase):
    """Home reads on the page's signal and refreshes through ctx.poll, so no
    gauge, status or section poll outlives a visit; its service list stays the
    one request the header pill shares; its buttons are data-actions on one
    listener; module state is data, never DOM (Task 10)."""

    def code(self):
        return js_code_only(module_source("index"))

    def test_every_read_is_on_the_pages_signal(self):
        code = self.code()
        self.assertEqual(len(re.findall(r"\bgetJSON\(", code)), 5,
                         "the event log, news, streams, requests, releases")
        self.assertEqual(len(re.findall(r"WS\.getJSON\([^;]*?, \{ signal: signal \}\)", code)), 5)
        fetches = [m.start() for m in re.finditer(r"(?<![.\w])fetch\(", code)]
        self.assertEqual(len(fetches), 2, "the gauges and the sidebar's request badge")
        for at in fetches:
            self.assertIn("signal: signal", ",".join(call_args(code, at + len("fetch"))), code[at:at + 60])
        # A page left mid-request says nothing and writes nothing.
        self.assertEqual(code.count("if (signal.aborted || isAbort(error)) return;"), 6,
                         "five onError handlers and the gauges' catch")
        self.assertRegex(code, r"catch \(e\) \{\s*if \(signal\.aborted \|\| isAbort\(e\)\) return;")
        for name in ("renderNews", "renderActiveStreams", "renderRecentRequests", "renderServices",
                     "renderUpcomingReleases"):
            self.assertRegex(function_body(code, name), r"^\s*if \(signal\.aborted\) return;", name)

    def test_the_service_list_is_the_pills_request(self):
        src = module_source("index")
        self.assertIn("return WS.swr('services', WS.serviceStatus, renderServices);", src)
        self.assertNotIn("service-status", src, "never a request of its own")
        shell = js_code_only((STATIC / "js" / "shell.js").read_text(encoding="utf-8"))
        body = function_body(shell, "serviceStatus")
        # Shared while on its way and for 5 s after, by the clock: a timer
        # would be the asking page's, and outlive it. The monotonic clock, so
        # a wall clock set back cannot stretch it (app/tests/js/service_status.mjs
        # runs it).
        self.assertIn("if (statusPromise && (!statusAt || performance.now() - statusAt < 5000)) return statusPromise;", body)
        self.assertIn("statusAt = performance.now();", body)
        self.assertNotIn("statusAt = Date.now()", body)
        self.assertNotRegex(body, r"\bsetTimeout\(")
        leaks = (STATIC / "js" / "debug-leaks.js").read_text(encoding="utf-8")
        self.assertIn("export const SELF_OWNED_FILES = ['ui.js', 'shell.js#serviceStatus', 'install.js', 'engine.js', "
                      "'saves.js', 'features.js',\n  'findplace.js', 'safetynet.js'];", leaks)

    def test_the_clock_test_runs_locally_and_in_ci(self):
        from app.tests.test_theme_engine import repo_file
        for parts in (("package.json",), (".github", "workflows", "docker-publish.yml")):
            self.assertIn("node app/tests/js/service_status.mjs", repo_file(self, *parts), "/".join(parts))

    def test_timers_and_refresh_are_the_pages(self):
        code = self.code()
        self.assertNotRegex(code, r"\bWS\.poll\(")
        self.assertNotRegex(code, r"(?<![.\w])setTimeout\(", "one-off timers go through ctx.setTimeout")
        self.assertEqual(len(re.findall(r"\bctx\.poll\(", code)), 3)
        self.assertIn("ctx.poll(loadSystemStats, 1000);", code)
        self.assertIn("ctx.poll(tickLastChecked, 1000);", code)
        self.assertRegex(code, r"ctx\.poll\(function\(\) \{[^}]*loadRequestCount\(\);\s*\}, 30000\);")
        # The first read is the page's own (a poll on screen reads nothing at once).
        self.assertIn("first.push(loadRequestCount());", code)

    def test_module_state_is_data(self):
        # Top level: constants that hold data, and functions. No let or var,
        # so nothing there can keep a node (or a visit's state) alive.
        src = module_source("index")
        names = re.findall(r"^(?:const|let|var) (\w+)", src, re.M)
        self.assertEqual(sorted(names), ["HOMELAB_ICONS", "NEWS_EMPTY_HTML", "NEWS_FRESH_MS",
                                         "PINNED_ICON", "PINNED_PREFIX",
                                         "REQUEST_TONE_CLASSES", "SECTIONS", "STREAMS_PER_PAGE", "STREAM_CARD_SHAPE",
                                         "WHEEL_DRAG_PX", "WHEEL_IDLE_MS", "WHEEL_LINES", "WHEEL_MS", "WHEEL_QUIET",
                                         "WHEEL_QUIET_PINNED", "WHEEL_SR_PREFIX", "WHEEL_STEP_PX"])
        self.assertNotRegex(src, r"^(?:let|var) ", )
        # Every lookup stays inside the page, but two: the header's status
        # pill and the top bar's title, which the gauges' copies go beside
        # (taken out again by the cleanup mount returns).
        code = self.code()
        self.assertEqual(len(re.findall(r"\bdocument\.getElementById\(", code)), 2)
        self.assertIn("var pill = document.getElementById('systemStatus');", src)
        self.assertIn("var barTitle = document.getElementById('wsBarTitle');", src)
        self.assertIn("return function () { removeHeaderGauges(); };", code)

    def test_home_has_no_continue_row(self):
        # Continue lives on Books only (Jordan, 2026-10-05): Home neither draws
        # it, reserves room for it, nor loads books.js to do so.
        h = read("index")
        page = h[h.index('<div id="wsPage"'):h.index("</main>")]
        self.assertNotIn('data-arrive="continue"', page)
        self.assertNotIn("homeContinue", h)
        self.assertNotIn("data-ws-dep", h)
        src = module_source("index")
        for gone in ("renderContinueRow", "/api/books/continue", "data-ws-dep", "webservarr_books_continue"):
            self.assertNotIn(gone, src, gone)
        loader = (STATIC / "js" / "theme-loader.js").read_text(encoding="utf-8")
        self.assertNotIn("data-home-continue", loader)

    def test_the_buttons_are_data_actions(self):
        h = read("index")
        for action in ("streams-prev", "streams-next"):
            self.assertEqual(h.count(f'data-action="{action}"'), 1, action)
        self.assertNotIn("scrollStreams(", h)
        src = module_source("index")
        self.assertEqual(src.count('data-action="stream-info"'), 1)
        self.assertEqual(h.count('data-action="event-latest"'), 1)
        for action in ("streams-prev", "streams-next", "stream-info", "event-latest"):
            self.assertIn(f"case '{action}':", src, action)
        # One click listener, on the page, for them and the news cards' Read
        # more. The event log's wheel has its own input listeners (scroll,
        # drag, keys): those are not buttons.
        code = self.code()
        self.assertEqual(re.findall(r"\b(\w+)\.addEventListener\(", code), ["wheel"] * 6 + ["root"])
        self.assertEqual(re.findall(r"\bwheel\.addEventListener\('(\w+)'", src),
                         ["wheel", "touchstart", "touchmove", "touchend", "touchcancel", "keydown"])
        self.assertIn("root.addEventListener('click', function (e) {", src)
        self.assertIn("var toggle = t.closest('[data-news-toggle]');", src)

    def test_sections_follow_the_pages_own_payload(self):
        # The payload of the page the router swapped in, as html[data-home-hide]
        # is (the router copies <html>'s data-* flags on every swap).
        src = module_source("index")
        self.assertIn("var branding = (ctx.data && ctx.data.branding) || window.WEBSERVARR_THEME || {};", src)
        self.assertNotIn("WEBSERVARR_THEME ||", src.replace("window.WEBSERVARR_THEME || {};", ""))
        router = function_body(js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8")), "syncHtmlFlags")
        self.assertIn("if (a.name.indexOf('     ') === 0 && !fresh.hasAttribute(a.name)) root.removeAttribute(a.name);", router)


class BooksPage(unittest.TestCase):
    """Books reads everything on the page's signal and times everything with the
    visit; its Continue row and library are inside #wsPage; the sign-in helper
    starts from mount (the hand-off itself is pinned in test_kavita_connect)."""

    def code(self):
        return js_code_only(module_source("books"))

    def test_every_request_is_on_the_pages_signal(self):
        code = self.code()
        self.assertNotRegex(code, r"(?<![.\w])fetch\(", "every read goes through WS.getJSON")
        self.assertEqual(len(re.findall(r"\bgetJSON\(", code)), 2, "readLive (every list) and the next page")
        src = module_source("books")
        self.assertIn("WS.getJSON(url, { signal: signal })", src)
        self.assertIn("WS.getJSON(libraryUrl(state.cursor), { signal: signal })", src)
        # A page left mid-request says nothing.
        self.assertRegex(function_body(code, "quiet"), r"return signal\.aborted \|\| isAbort\(err\)")

    def test_timers_are_the_pages(self):
        code = self.code()
        self.assertNotRegex(code, r"(?<![.\w])setTimeout\(", "one-off timers go through ctx.setTimeout")
        self.assertNotRegex(code, r"\bWS\.poll\(")
        self.assertIn("ctx.poll(", code)
        self.assertIn("ctx.clearTimeout(searchTimer);", module_source("books"))

    def test_the_sections_are_marked_to_arrive_top_down(self):
        h = read("books")
        page = h[h.index('<div id="wsPage"'):h.index("</main>")]
        order = re.findall(r'data-arrive="(\w+)"', page)
        self.assertEqual(order, ["continue", "library"])
        src = module_source("books")
        for key in order:
            self.assertIn(f"WS.arrive('{key}'", src)
        self.assertNotRegex(self.code(), r"\bdocument\.getElementById\(", "lookups stay inside ctx.root")

    def test_it_writes_text_only(self):
        code = self.code()
        self.assertNotRegex(code, r"innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|document\.write")
        self.assertNotIn("onerror", read("books"))

    def test_the_search_wait_and_the_cards_links(self):
        src = module_source("books")
        self.assertIn("const SEARCH_WAIT_MS = 300;", src)
        self.assertIn("'/books/' + encodeURIComponent(String(card.id))", src)
        self.assertIn("'/books/series?name=' + encodeURIComponent(card.series || '')", src)

    def test_continue_is_always_shown_and_its_cards_room_held_only_when_this_person_had_some(self):
        loader = (STATIC / "js" / "theme-loader.js").read_text(encoding="utf-8")
        self.assertIn("data.page !== 'books'", loader)
        self.assertIn("['continue', 'data-books-continue']", loader)
        self.assertIn("'webservarr_books_' + rows[i][0] + ':' + name", loader)
        self.assertIn("const CONTINUE_KEY = 'webservarr_books_continue:';", module_source("books"))
        h = read("books")
        self.assertNotIn("#continueHost { display: none; }", h)
        self.assertIn('#continueHost [data-skel="row"] { display: none; }', h)
        self.assertIn('html[data-books-continue] #continueHost [data-skel="row"] { display: flex; }', h)
        self.assertIn('html[data-books-continue] #continueHost [data-skel="empty"] { display: none; }', h)
        # The empty skeleton is the empty line's own box.
        self.assertIn('<p data-skel="empty" class="text-[15px] leading-6" aria-hidden="true">&nbsp;</p>', h)
        self.assertIn("el('p', 'text-[15px] leading-6 text-frosted-blue/70',", module_source("books"))


    def test_the_persons_own_writes_go_through_one_helper(self):
        # Books 3b: My list, Up next and ratings are the only writes on the Books
        # pages. They go through books.js sendBooks, the one place that calls
        # fetch (same-origin credentials); every read is still WS.getJSON.
        code = self.code()
        body = function_body(code, "sendBooks")
        self.assertIn("window.fetch(url, init)", body)
        self.assertNotRegex(code.replace(body, ""), r"\bfetch\(")
        self.assertIn("credentials: 'same-origin'", module_source("books"))
        calls = re.findall(r"sendBooks\('(\w+)'", module_source("books"))
        calls += re.findall(r"change\('\w+', \{[^}]*\}, '(\w+)'", module_source("book"))
        self.assertTrue(calls)
        self.assertTrue(set(calls) <= {"PUT", "DELETE", "POST"}, calls)

    def test_up_next_and_my_list_are_held_like_continue(self):
        loader = (STATIC / "js" / "theme-loader.js").read_text(encoding="utf-8")
        self.assertIn("['upnext', 'data-books-upnext']", loader)
        self.assertIn("['mylist', 'data-books-mylist']", loader)
        self.assertIn("'webservarr_books_' + rows[i][0] + ':' + name", loader)
        h = read("books")
        self.assertIn("#upnextHost, #mylistHost { display: none; }", h)
        self.assertIn("html[data-books-upnext] #upnextHost { display: block; }", h)
        self.assertIn("html[data-books-mylist] #mylistHost { display: block; }", h)
        src = module_source("books")
        self.assertIn("key: 'webservarr_books_upnext:'", src)
        self.assertIn("key: 'webservarr_books_mylist:'", src)
        # Inside the library section, after Continue and before the toolbar: one write with the books.
        section = h[h.index('id="librarySection"'):h.index('id="toolbar"')]
        self.assertLess(section.index('id="continueHost"'), section.index('id="upnextHost"'))
        self.assertLess(section.index('id="upnextHost"'), section.index('id="mylistHost"'))

    def test_the_filters_row_is_held_from_the_first_paint(self):
        # The toolbar's filters: an address that carries one holds the pills' row before the module runs.
        loader = (STATIC / "js" / "theme-loader.js").read_text(encoding="utf-8")
        self.assertIn("/[?&](author|series|narrator)=[^&]/.test(window.location.search)", loader)
        self.assertIn("setAttribute('data-books-filtered', '')", loader)
        h = read("books")
        self.assertIn('#toolbarSkel [data-skel="filters"] { display: none; }', h)
        self.assertIn('html[data-books-filtered] #toolbarSkel [data-skel="filters"] { display: block; }', h)
        src = module_source("books")
        self.assertIn("html.removeAttribute('data-books-filtered');", src)

    def test_the_discovery_shelves_are_held_like_the_rows_above(self):
        # Books 3c: Recently added and Popular on the server, after My list and before the toolbar.
        loader = (STATIC / "js" / "theme-loader.js").read_text(encoding="utf-8")
        self.assertIn("['recent', 'data-books-recent']", loader)
        self.assertIn("['popular', 'data-books-popular']", loader)
        h = read("books")
        self.assertIn("#recentHost, #popularHost { display: none; }", h)
        self.assertIn("html[data-books-recent] #recentHost { display: block; }", h)
        self.assertIn("html[data-books-popular] #popularHost { display: block; }", h)
        src = module_source("books")
        self.assertIn("key: 'webservarr_books_recent:'", src)
        self.assertIn("key: 'webservarr_books_popular:'", src)
        self.assertIn("const ROW_ORDER = ['continue', 'upnext', 'mylist', 'recent', 'popular'];", src)
        section = h[h.index('id="librarySection"'):h.index('id="toolbar"')]
        self.assertLess(section.index('id="mylistHost"'), section.index('id="recentHost"'))
        self.assertLess(section.index('id="recentHost"'), section.index('id="popularHost"'))
        # Your stats is a plain link at the end of the search row.
        self.assertIn('<a id="statsLink" href="/books/stats"', h)

    def test_the_first_visit_guide_is_the_shared_engine_started_once(self):
        # Jordan 2026-10-03: the guide is rebuilt for Books on tour.js (the reader's engine), runs on a
        # person's first visit only, starts when the books are drawn, and the help button runs it again.
        h = read("books")
        self.assertIn('<script src="/static/js/tour.js?v=5" data-ws-page-script></script>', h)
        self.assertEqual(h.count('id="helpBtn"'), 1)
        src = module_source("books")
        self.assertIn("const GUIDE_KEY = 'webservarr_books_guide_seen:';", src)
        self.assertEqual(len(re.findall(r"^\s+target: '", src[src.index("const GUIDE_STEPS"):src.index("function isAbort")], re.M)), 4)
        for words in ("#booksSearch", "#continueHost [data-continue]", "#formatChips", "#libraryGrid > li:first-child"):
            self.assertIn(f"target: '{words}'", src)
        self.assertIn("window.WebServarrTour.init({", src)
        self.assertIn("seenKey: GUIDE_KEY + user,", src)
        self.assertIn("helpBtn: $('helpBtn'),", src)
        self.assertIn("autoStart: false,", src)
        self.assertIn("signal: signal", src[src.index("window.WebServarrTour.init({"):])
        # Offered once the books are drawn, and marked seen as soon as it has been shown.
        self.assertRegex(function_body(js_code_only(src), "renderLibrary"), r"showBody\('\s*'\);\s*setMore\(data\.next_cursor\);\s*offerGuide\(\);")
        self.assertIn("if (first && guide.isActive()) storageSet(GUIDE_KEY + user, '1');", src)


class BookPages(unittest.TestCase):
    """The book page (pages/book.js) and the author, narrator and series pages
    (pages/books-list.js, two partials). They read on the page's signal, time
    everything with the visit, write text only, and put a name in the address
    only as a query value, encoded."""

    def sources(self):
        return {"book": module_source("book"), "books-list": module_source("books-list"),
                "books-stats": module_source("books-stats")}

    def test_every_request_is_on_the_pages_signal(self):
        for name, src in self.sources().items():
            with self.subTest(name):
                code = js_code_only(src)
                self.assertNotRegex(code, r"(?<![.\w])fetch\(", "every read goes through WS.getJSON")
                self.assertEqual(len(re.findall(r"\bgetJSON\(", code)), 1)
                self.assertTrue("WS.getJSON('/api/books/' + encodeURIComponent(String(state.id)), { signal: signal })" in src
                                or "WS.getJSON(target.url, { signal: signal })" in src
                                or "WS.getJSON(url, { signal: signal })" in src)
                self.assertRegex(function_body(code, "quiet"), r"return signal\.aborted \|\| isAbort\(err\)")

    def test_timers_are_the_pages(self):
        for name, src in self.sources().items():
            with self.subTest(name):
                code = js_code_only(src)
                self.assertNotRegex(code, r"(?<![.\w])setTimeout\(", "one-off timers go through ctx.setTimeout")
                self.assertNotRegex(code, r"\bsetInterval\(|\bWS\.poll\(|\bctx\.poll\(")

    def test_they_write_text_only(self):
        for name, src in self.sources().items():
            with self.subTest(name):
                self.assertNotRegex(js_code_only(src), r"innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|document\.write")
                self.assertNotRegex(js_code_only(src), r"\bdocument\.getElementById\(", "lookups stay inside ctx.root")
        for name in ("book", "books-person", "books-series", "books-stats"):
            with self.subTest(name):
                self.assertNotIn("onerror", read(name))

    def test_each_page_is_one_section_that_arrives_at_once(self):
        for name, key, src in (("book", "book", "book"), ("books-person", "list", "books-list"),
                               ("books-series", "list", "books-list"), ("books-stats", "stats", "books-stats")):
            with self.subTest(name):
                h = read(name)
                page = h[h.index('<div id="wsPage"'):h.index("</main>")]
                self.assertEqual(re.findall(r'data-arrive="(\w+)"', page), [key])
                self.assertIn(f"WS.arrive('{key}'", module_source(src))
                self.assertEqual(page.count("<h1"), 1)

    def test_the_two_list_pages_say_which_they_are(self):
        self.assertIn('data-kind="person"', read("books-person"))
        self.assertIn('data-kind="series"', read("books-series"))
        self.assertIn("root.getAttribute('data-kind')", module_source("books-list"))

    def test_names_travel_as_encoded_query_values(self):
        book = module_source("book")
        self.assertIn("'/books/person?role=' + role + '&name=' + encodeURIComponent(name)", book)
        self.assertIn("'/books/series?name=' + encodeURIComponent(b.series)", book)
        lst = module_source("books-list")
        self.assertIn("'/api/books/series?name=' + encodeURIComponent(name)", lst)
        self.assertIn("'/api/books/person?role=' + role + '&name=' + encodeURIComponent(name)", lst)
        for src in (book, lst):
            self.assertNotRegex(js_code_only(src), r"/books/(person|series)/")
        self.assertIn("'/api/books/' + encodeURIComponent(String(state.id))", book)

    def test_read_goes_only_to_the_reader_and_requests_only_to_requests(self):
        book = module_source("book")
        self.assertIn("link.indexOf('/reader?') === 0", book)
        self.assertIn("link.indexOf('/requests?q=') === 0", book)
        # Read a sample (books 3b) is the checked reader address in sample mode, nothing else.
        self.assertIn("const SAMPLE_PARAM = '&sample=1';", book)
        self.assertIn("a.href = href + SAMPLE_PARAM;", book)
        self.assertIn("cell.appendChild(readSampleLink(href));", book)
        # Its banner holds its room from the first paint of a full load.
        loader = (STATIC / "js" / "theme-loader.js").read_text(encoding="utf-8")
        self.assertIn("if (m && m[1] === '1') document.documentElement.setAttribute('data-reader-sample', '');", loader)
        self.assertIn("html[data-reader-sample] #sampleBanner[hidden] { display: block; }", read("reader"))
        # A queue card's Read follows only the reader's own address too.
        self.assertIn("f.read_url.indexOf('/reader?') === 0", module_source("books"))

    def test_the_hand_off_is_the_books_pages_helper(self):
        for name in ("book", "books-person", "books-series"):
            with self.subTest(name):
                self.assertIn('<script src="/static/js/kavita-connect.js?v=1" data-ws-page-script></script>', read(name))
        # (Your stats runs no hand-off: its reading note sends the person to Books, which does.)
        for name, src in self.sources().items():
            if name == "books-stats":
                self.assertNotIn("WSKavita", src)
                continue
            self.assertIn("window.WSKavita.init()", src)
            self.assertIn("window.WSKavita.arrivedFromFailedConnect()", src)
            self.assertIn("helper.reconnect(connectProblem)", src)

    def test_the_player_is_watched_for_the_visit_only(self):
        code = js_code_only(module_source("book"))
        self.assertIn("p.on('change', syncListen)", module_source("book"))
        self.assertIn("state.unwatch();", code)
        # Books 3b: the samples' event too, ended with the visit.
        self.assertIn("const unSample = p.on('sample-change', onSample);", module_source("book"))
        self.assertIn("if (typeof unSample === 'function') unSample();", module_source("book"))
        self.assertIn("p.open(key, { autoplay: true })", module_source("book"))

    def test_the_card_helpers_are_books_js_exports(self):
        books = module_source("books")
        for name in ("renderBookCard", "coverBox", "noteLine"):
            self.assertRegex(books, rf"export function {name}\(")
        # T4C2: no import statement (a bare './books.js' is not stamped, so a cached
        # old file could pair with a new module); the page names the file, the
        # server stamps it with that file's own content hash (test_page_gating).
        for name in ("book", "books-list", "books-stats"):
            with self.subTest(name):
                src = module_source(name)
                self.assertNotRegex(js_code_only(src), r"(?m)^\s*import\b[^(]")
                self.assertNotIn("./books.js'", src.replace("|| './books.js'", ""))
                self.assertIn("await import(root.getAttribute('data-ws-dep') || './books.js')", src)
        for name in ("book", "books-person", "books-series", "books-stats"):
            with self.subTest(name):
                self.assertIn('data-ws-dep="/static/js/pages/books.js?v=1"', read(name))


class ReaderPage(unittest.TestCase):
    """The reader is a full-screen view in the site's one document: the server
    marks it data-shell="hidden" (the shell hidden, #wsPlayer kept), its
    bottom chrome stays clear of the player, its settings go with the page,
    and its last reading position is saved as it is left, by a request the
    visit's abort cannot stop (Task 11)."""

    def code(self):
        return js_code_only(module_source("reader"))

    def test_the_server_marks_the_reader_full_screen(self):
        pages = (STATIC.parent / "pages.py").read_text(encoding="utf-8")
        self.assertRegex(pages, r"if name == \"reader\":\n(?:\s*#[^\n]*\n)*\s*attrs \+= ' data-shell=\"hidden\"'")
        self.assertEqual(pages.count('data-shell="hidden"'), 1)

    def test_the_shell_is_hidden_and_takes_no_focus(self):
        theme = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        for sid in ("desktopSidebar", "appHeader", "mobileTopBar", "wsTabBar", "scrollDownHint", "pageOffBanner"):
            self.assertRegex(theme, rf'html\[data-shell="hidden"\] #{sid}\b[^{{]*\{{ display: none; \}}', sid)
        self.assertNotRegex(theme, r'html\[data-shell="hidden"\] #wsPlayer')

    def test_the_bottom_chrome_clears_the_player(self):
        h = read("reader")
        head = h[:h.index("</head>")]
        self.assertIn("#readerFooter, #tocPanel { bottom: var(--ws-player-h); }", head)
        self.assertRegex(head, r"\.nav-zone \{[^}]*bottom: var\(--ws-player-h\);")
        self.assertRegex(head, r"#settingsPanel \{\s*top: auto; right: 0; left: 0; bottom: var\(--ws-player-h\);")

    def test_the_settings_go_with_the_page(self):
        body = function_body(self.code(), "applyPrefs")
        self.assertIn("var style = root.style;", body)
        self.assertNotIn("document.documentElement.style", body)

    def test_every_request_is_on_the_pages_signal(self):
        code = self.code()
        fetches = [m.start() for m in re.finditer(r"(?<![.\w])fetch\(", code)]
        self.assertEqual(len(fetches), 1, "every call goes through kavita()")
        self.assertIn("if (!('signal' in options)) options.signal = signal;", module_source("reader"))
        # The one call off the visit's signal: a progress write, which must
        # outlive the visit so the last save lands after it (fix round 2).
        # Its signal is the writer's deadline for that write alone (fix
        # round 4), never the visit's.
        self.assertEqual(len(re.findall(r"\bsignal: null,", code)), 0)
        send = function_body(module_source("reader"), "sendProgress")
        self.assertIn("function sendProgress(page, deadline) {", module_source("reader"))
        self.assertIn("signal: deadline,\n      keepalive: true,", send)
        self.assertNotRegex(code, r"(?<![.\w])setTimeout\(", "one-off timers go through ctx.setTimeout")
        self.assertIn("saveTimer = ctx.setTimeout(saveProgress, SAVE_DEBOUNCE_MS);", code)
        # The one timer not the visit's: a write's deadline, which must outlive
        # the visit as the write does, on the writer's clock (the window).
        writer = function_body(code, "progressWriter")
        self.assertEqual(len(re.findall(r"\btimers\.setTimeout\(", code)), 1)
        # The soft-leave save is never aborted by it (fix round 5): the queue
        # only stops waiting, and its answer still counts when it comes.
        self.assertIn("timer = timers.setTimeout(function () { if (!last) deadline.abort(); resolve(TIMED_OUT); }, WRITE_DEADLINE_MS);", writer)
        self.assertIn("if (last) answer.then(function (ok) { take(at, page, ok); });", writer)
        self.assertIn("return enqueue(page, ++q.sends, true);", writer)
        self.assertEqual(len(re.findall(r"\benqueue\(", writer)), 3, "the definition, go() and leave()")
        self.assertIn("const timers = clock || globalThis;", writer)
        self.assertIn("const deadline = new AbortController();", writer)

    def test_the_position_is_saved_on_leaving(self):
        # A soft navigation away: the document keeps running, so the last
        # save goes through the writer's leave(), after any write in flight
        # (fix round 2). A hard exit (tab hidden or closed) cannot wait: a
        # beacon, recorded as the newest send.
        code = self.code()
        # The writer is let go of on every leave (fix round 4), with no save
        # when the position was never known.
        self.assertRegex(code, r"var leave = function \(\) \{\s*if \(writer\) writer\.leave\(positionKnown \? current\.page : null\);\s*\};")
        self.assertEqual(len(re.findall(r"\breturn leave;", code)), 2, "both ways out of mount hand it to the router")
        save = function_body(code, "saveProgress")
        self.assertIn("var held = useBeacon ? (writer ? writer.confirmed : -1) : lastSaved;", save)
        self.assertLess(save.index("if (!positionKnown || current.page === held) return;"), save.index("sendBeacon("))
        self.assertIn("writer.sent(page);", save)
        self.assertIn("writer.write(page);", save)
        self.assertIn("writer.known(page);", function_body(code, "restoreProgress"))
        # One write in flight at a time (fix round 1, R1): the writer is pure,
        # and app/tests/js/reader_progress.mjs runs it with late, failed and
        # out-of-order answers.
        # One queue per book for the whole document, keyed by the chapter
        # Kavita keeps the position under (fix round 3): made once the
        # chapter is known; the saved position is asked for only after every
        # save already queued for the book has answered.
        self.assertIn("var writer = null;", code)
        self.assertEqual(len(re.findall(r"\bwriter = progressWriter\(", code)), 1)
        self.assertIn("writer = progressWriter(sendProgress, 'chapter:' + book.chapterId);", module_source("reader"))
        self.assertLess(code.index("book.chapterId = res.chapterId;"), code.index("writer = progressWriter("))
        # ...but no longer than RESTORE_WAIT_MS, on the visit's timers (fix
        # round 4), so a save that never answers cannot keep the book shut.
        self.assertIn("return writer.settled(RESTORE_WAIT_MS, ctx).then(fetchProgress)", function_body(code, "restoreProgress"))
        self.assertLess(code.index("if (signal.aborted) throw new Error("), code.index("writer = progressWriter("))
        src = module_source("reader")
        self.assertRegex(src, r"export function progressWriter\(send, key, clock\) \{")
        self.assertIn("export const progressQueues = new Map();", src)
        self.assertIn("progressQueues.delete(key);", src)
        self.assertIn("return r.ok;", function_body(code, "sendProgress"))
        # The tab hidden or closed while reading: the beacon, until the visit ends.
        src = module_source("reader")
        self.assertIn("if (document.visibilityState === 'hidden') saveProgress(true);", src)
        self.assertIn("window.addEventListener('pagehide', function () { saveProgress(true); }, { signal: signal });", src)

    def test_it_titles_the_book_through_the_router(self):
        code = self.code()
        self.assertIn("ctx.setTitle(book.title);", code)
        self.assertNotIn("document.title", code)


class RequestsPage(unittest.TestCase):
    """Requests reads, posts and refreshes on the page's signal and poll; its
    16 inline handlers are data-actions on one click listener and a capturing
    error listener; the modal is inside #wsPage; the discover rows are markup
    in the first paint; the Seerr embed signs in from mount (Task 12)."""

    def code(self):
        return js_code_only(module_source("requests"))

    def test_every_request_is_on_the_pages_signal(self):
        code = self.code()
        fetches = [m.start() for m in re.finditer(r"(?<![.\w])fetch\(", code)]
        self.assertEqual(len(fetches), 8, "discover, both searches, a request, request status, "
                                          "the counts, the summary and the recent requests")
        # The two search reads are on the search's own signal, which the
        # page's aborts too (RequestsPage.test_an_older_search_never_paints).
        on_search = 0
        for at in fetches:
            args = ",".join(call_args(code, at + len("fetch")))
            if "signal: ctl.signal" in args:
                on_search += 1
            else:
                self.assertIn("signal: signal", args, code[at:at + 60])
        self.assertEqual(on_search, 2, "the film/TV search and the book search")
        self.assertNotRegex(code, r"\bgetJSON\(")
        # A page left mid-request says nothing and writes nothing.
        self.assertEqual(len(re.findall(r"if \(signal\.aborted \|\| isAbort\(\w+\)\) return;", code)), 7,
                         "request status, discover, search, a request, the counts, the summary, the recent requests")

    def test_timers_and_refresh_are_the_pages(self):
        code = self.code()
        self.assertNotRegex(code, r"(?<![.\w])setTimeout\(", "one-off timers go through ctx.setTimeout")
        self.assertNotRegex(code, r"\bWS\.poll\(")
        self.assertRegex(code, r"ctx\.poll\(function \(\) \{\s*loadRequestCounts\(\);\s*loadExistingRequests\(\);\s*\}, REFRESH_MS\);")
        self.assertEqual(len(re.findall(r"\bctx\.poll\(", code)), 1)
        # The search wait is re-armed per keystroke and cancelled through the visit.
        self.assertIn("ctx.clearTimeout(searchTimer);", code)
        self.assertIn("searchTimer = ctx.setTimeout(function () {", code)
        # The scroll lock's failsafe and its listeners end with the visit.
        self.assertIn("_scrollLockFailsafe = ctx.setTimeout(unlockScroll, SEARCH_MOVE_DURATION + 2000);", code)
        for ev in ("wheel", "touchmove"):
            self.assertIn(f"window.addEventListener('{ev}', swallowScroll, {{ passive: false, signal: signal }});",
                          module_source("requests"))
        # A move still in flight when the page is left touches nothing.
        frame = function_body(code, "frame")
        self.assertRegex(frame, r"^\s*if \(signal\.aborted\) \{ _searchMoveRaf = null; return; \}")
        # The first read is the page's own (a poll on screen reads nothing at once).
        self.assertIn("Promise.all([RS.load(), loadRequestCounts(), loadLibrarySummary(), loadExistingRequests()])", code)

    def test_an_older_search_never_paints_over_a_newer_one(self):
        # Task 12 fix round 1 (RS1): "dune" (slow), cleared, then "matrix"
        # (fast): dune's answer landing last painted its results and count
        # under a box reading "matrix". A new search, or clearing the box,
        # aborts the one in flight, and an answer that is not the newest
        # search's touches nothing.
        src = module_source("requests")
        body = function_body(src, "performSearch")
        self.assertIn("var searchCtl = null;", src[src.index("export async function mount"):])
        start = body.index("if (searchCtl) searchCtl.abort();")
        self.assertLess(body.index("_currentSearchQuery = query;"), start)
        self.assertIn("var ctl = searchCtl = new AbortController();", body)
        # Chained to the visit: leaving the page aborts the search too.
        self.assertIn("signal.addEventListener('abort', function () { ctl.abort(); }, { once: true, signal: ctl.signal });", body)
        guard = "if (_currentSearchQuery !== query || searchCtl !== ctl) return;"
        at = body.index(guard)
        self.assertLess(body.index("var data = await resp.json();"), at)
        for write in ("_totalSearchPages =", "_searchResults = screenResults;", "$('searchResultCount')",
                      "renderSearchPage();", "updateSearchPagination();", "grid.textContent = '';\n        var emptyP"):
            later = body.index(write, body.index("var data = await resp.json();"))
            self.assertLess(at, later, write)
        # The late book merge answers only to the newest search as well.
        merge = body[body.index("bookSearch.then(function (bookResults) {"):]
        self.assertRegex(merge, r"^bookSearch\.then\(function \(bookResults\) \{\s*"
                                r"if \(signal\.aborted \|\| searchCtl !== ctl\) return;")
        # A failure of a search that has been overtaken says nothing either.
        catch = body[body.index("} catch (error) {"):]
        self.assertLess(catch.index("if (searchCtl !== ctl) return;"), catch.index("grid.textContent = '';"))
        self.assertIn("if (searchCtl) searchCtl.abort();", function_body(src, "clearSearch"))

    def test_the_inline_handlers_are_data_actions(self):
        h = read("requests")
        self.assertNotRegex(h, r"\son[a-z]+\s*=")
        src = module_source("requests")
        for action, n in (("search-prev", 1), ("search-next", 1), ("requests-prev", 1), ("requests-next", 1),
                          ("filter", 5), ("close-modal", 2), ("discover-scroll", 14)):
            self.assertEqual(h.count(f'data-action="{action}"'), n, action)
            self.assertIn(f"case '{action}':", src, action)
        for action in ("open-media", "request-media", "request-from-modal"):
            self.assertIn(f'data-action="{action}"', src, action)
            self.assertIn(f"case '{action}':", src, action)
        # A poster that fails shows its placeholder: marked data-fallback and
        # answered by one capturing listener, never an inline handler.
        self.assertIn('id="modalPoster" src="" alt="" class="absolute inset-0 w-full h-full object-cover" data-fallback/>', h)
        self.assertIn("'\" data-fallback/>'", src)
        self.assertIn("root.addEventListener('error', function (e) {", src)
        self.assertEqual(src.count("}, { capture: true, signal: signal });"), 2)

    def test_the_modal_is_inside_the_page(self):
        h = read("requests")
        page = h[h.index('<div id="wsPage"'):h.index("</main>")]
        self.assertEqual(h.count('id="mediaModal"'), 1)
        self.assertIn('id="mediaModal"', page)
        code = self.code()
        self.assertNotIn("document.body.appendChild", code)
        # Lookups stay inside the page; the one exception is the shell's phone bar.
        self.assertEqual(re.findall(r"\bdocument\.getElementById\(", code), ["document.getElementById("])
        self.assertIn("document.getElementById('mobileTopBar')", module_source("requests"))

    def test_module_state_is_data(self):
        # Top level: constants and functions; each visit's state lives in mount.
        src = module_source("requests")
        self.assertNotRegex(src, r"^(?:let|var) ")
        for name in ("_searchResults", "_allRequests", "_discoverItems", "_searchBarPosition"):
            self.assertIn(f"  var {name} = ", src[src.index("export async function mount"):], name)

    def test_the_discover_rows_scroll_with_the_visit(self):
        src = module_source("requests")
        self.assertIn("WS.dragScroll(el, { signal: signal });", src)
        shell = js_code_only((STATIC / "js" / "shell.js").read_text(encoding="utf-8"))
        body = function_body(shell, "dragScroll")
        adds = re.findall(r"\bel\.addEventListener\(", body)
        self.assertEqual(len(adds), 9)
        self.assertEqual(len(re.findall(r"\}?, on\(\{[^)]*\}\)\);", body)), 9, "every row listener takes the signal")
        self.assertIn("if (signal) o.signal = signal;", body)

    def test_the_status_section_follows_the_server_flag(self):
        # html[data-rs-empty] is the server's (pages.py), copied onto <html> on
        # every swap (router syncHtmlFlags); the page only ever lifts it.
        load = function_body(module_source("requests"), "load")
        self.assertIn("document.documentElement.removeAttribute('data-rs-empty');", load)
        self.assertNotIn("setAttribute", load)

    def test_the_embed_signs_in_from_mount_once_on_screen(self):
        h = read("requests-embed")
        page = h[h.index('<div id="wsPage"'):h.index("</main>")]
        self.assertIn('id="iframeContainer"', page)
        src = module_source("requests-embed")
        code = js_code_only(src)
        mount = code[code.index("export async function mount"):]
        # Nothing at load: the module only defines.
        self.assertEqual(re.findall(r"^\S.*$", code[:code.index("export async function mount")], re.M),
                         ["function isAbort(e) { return !!e && e.name === '          '; }"])
        self.assertIn("await new Promise(function (resolve) { WS.whenActive(resolve); });", mount)
        self.assertIn("await fetch('/api/integrations/seerr-auth', { method: 'POST', signal: signal });", src)
        self.assertIn("await fetch('/api/integrations/seerr-url', { signal: signal });", src)
        self.assertLess(src.index("WS.whenActive(resolve)"), src.index("/api/integrations/seerr-auth"))
        self.assertEqual(code.count("if (signal.aborted || isAbort(e)) return;"), 2)
        self.assertIn("container.appendChild(iframe);", src)
        self.assertNotIn("document.body", code)
        # The shell's scripts are all on the page, as on every other page.
        self.assertIn('<script src="/static/js/notifications.js?v=3"></script>', h)


class FixRound11(unittest.TestCase):
    """Task 11 fix round 1: the router keeps the viewport <meta> in step (V1);
    a visit's timers hold one abort listener, and a re-armed timer is
    cancelled with ctx.clearTimeout (L1); the reader's writes go one at a
    time (R1)."""

    def router(self):
        return js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8"))

    def test_the_viewport_follows_the_page(self):
        self.assertIn('<meta content="width=device-width, initial-scale=1.0, viewport-fit=cover" name="viewport"/>',
                      read("reader"))
        self.assertNotIn("viewport-fit", read("books"))
        body = function_body(self.router(), "syncViewport")
        self.assertIn("if (live.getAttribute('       ') !== content) live.setAttribute('       ', content);", body)
        swap = function_body(self.router(), "swapDom")
        self.assertLess(swap.index("old.replaceWith("), swap.index("syncViewport(doc);"))

    def test_a_visit_has_one_timer_listener(self):
        code = self.router()
        self.assertRegex(code, r"export function visitTimers\(signal, set, clear\) \{")
        self.assertIn("const timers = visitTimers(signal);", code)
        self.assertIn("setTimeout: timers.setTimeout,", code)
        self.assertIn("clearTimeout: timers.clearTimeout,", code)
        body = function_body(code, "visitTimers")
        self.assertEqual(body.count("addEventListener("), 1)
        self.assertNotIn("removeEventListener", body)

    def test_re_armed_timers_are_cancelled_through_the_visit(self):
        # A native clearTimeout on a ctx timer leaves its id pending until the
        # visit ends; every re-armed ctx timer goes through ctx.clearTimeout.
        self.assertIn("ctx.clearTimeout(searchTimer);", module_source("books"))
        self.assertIn("ctx.clearTimeout(saveTimer);", module_source("reader"))
        settings = STATIC / "js" / "settings"
        for name, timer in (("pages", "liveTimer"), ("general", "typing"), ("appearance", "fontTimer")):
            src = (settings / f"{name}.js").read_text(encoding="utf-8")
            self.assertIn("cancel = ctx.clearTimeout;", src, name)
            self.assertIn(f"cancel({timer});", src, name)
            self.assertNotIn(f"clearTimeout({timer})", src, name)
        for p in sorted((STATIC / "js" / "pages").glob("*.js")):
            code = js_code_only(p.read_text(encoding="utf-8"))
            self.assertNotRegex(code, r"(?<![.\w])clearTimeout\(", f"{p.name}: a ctx timer cleared natively")

    def test_the_js_checks_run_locally_and_in_ci(self):
        from app.tests.test_theme_engine import repo_file
        for parts in (("package.json",), (".github", "workflows", "docker-publish.yml")):
            for js in ("reader_progress.mjs", "router_runtime.mjs"):
                self.assertIn(f"node app/tests/js/{js}", repo_file(self, *parts), "/".join(parts))
        # The runtime cases need the dev packages: CI installs them first.
        ci = repo_file(self, ".github", "workflows", "docker-publish.yml")
        js = ci[ci.index("  js-checks:"):ci.index("  build-and-push:")]
        self.assertLess(js.index("npm ci"), js.index("node app/tests/js/router_runtime.mjs"))


class TourTeardown(unittest.TestCase):
    """The guide engine (tour.js) is a page helper: it defines at load, and a
    tour started with a visit's signal ends with it, whole (Task 11)."""

    def test_it_ends_with_the_visit(self):
        src = (STATIC / "js" / "tour.js").read_text(encoding="utf-8")
        code = js_code_only(src)
        abort = re.search(r"signal\.addEventListener\('     ', function \(\) \{", code)
        self.assertIsNotNone(abort, "no teardown on the visit's signal")
        body = code[abort.end():matching_brace(code, abort.end() - 1)]
        for step in ("clearTimeout(startTimer);", "stop();", "layer.remove();"):
            self.assertIn(step, body, step)
        self.assertNotIn("finish()", body, "a tour cut short is recorded as seen")
        self.assertIn("clearTimeout(placeTimer);", function_body(code, "stop"))
        for listener in (r"window\.addEventListener\('      ', place, signal \? \{ signal: signal \}",
                         r"window\.addEventListener\('      ', place, signal \? \{ capture: true, signal: signal \}",
                         r"help\.addEventListener\('     ', start, signal \? \{ signal: signal \}",
                         r"\}, signal \? \{ capture: true, signal: signal \} : true\);"):
            self.assertRegex(code, listener)
        # The top level only defines WebServarrTour.
        self.assertEqual(re.findall(r"window\.(\w+) =", code), ["WebServarrTour"])


class PageOffBanner(unittest.TestCase):
    """"This page is turned off" (pages.py PAGE_OFF_BANNER) is appended to the
    header, outside #wsPage, so a swap alone would leave it behind or never
    add it. The router brings it in step with the page it swaps in."""

    def router(self):
        return (STATIC / "js" / "router.js").read_text(encoding="utf-8")

    def test_the_swap_brings_the_banner_in_step(self):
        body = function_body(self.router(), "syncPageOffBanner")
        self.assertIn("const live = document.getElementById('pageOffBanner');", body)
        self.assertIn("const fresh = doc.getElementById('pageOffBanner');", body)
        self.assertRegex(body, r"if \(!fresh\) \{\s*if \(live\) live\.remove\(\);\s*return;\s*\}")
        self.assertIn("if (live) live.replaceWith(copy);", body)
        self.assertIn("else document.getElementById('wsPage').before(copy);", body)
        swap = function_body(self.router(), "swapDom")
        self.assertLess(swap.index("old.replaceWith("), swap.index("syncPageOffBanner(doc);"))

    def test_the_banner_is_the_one_the_server_renders(self):
        pages = (STATIC.parent / "pages.py").read_text(encoding="utf-8")
        start = pages.index("PAGE_OFF_BANNER = (")
        self.assertIn('id="pageOffBanner"', pages[start:pages.index("\n)\n", start)])

    def test_right_above_wspage_is_where_the_server_puts_it(self):
        # The header marker (and so the banner after it) is followed by
        # #wsPage with nothing but comments and white space between.
        for name in CONVERTED:
            with self.subTest(name):
                self.assertRegex(read(name), r'<!-- ws:header -->(?:\s|<!--.*?-->)*<div id="wsPage"')


class OneShellOutsideThePage(unittest.TestCase):
    """Nothing outside #wsPage is ever swapped: the document keeps what the
    first page it loaded rendered there for its whole life. So every shell
    page renders the same thing there. News and Wiki once put the scroller on
    <main>: arrived at from any other page on a desktop, under that page's
    overflow-hidden <main>, they could not scroll (final review C1)."""

    def outside(self, name):
        h = read(name)
        body = re.search(r"<body\b[^>]*>", h)
        main = re.compile(r"<main\b[^>]*>").search(h, body.end())
        between = re.sub(r"<!--.*?-->", "", h[body.end():main.start()], flags=re.S).strip()
        # After </main>: the shell's scripts, then the page's own helpers.
        tail = re.sub(r"<!--.*?-->", "", h[h.rindex("</main>"):h.rindex("</body>")], flags=re.S)
        shared = [m.group(0) for m in _SCRIPT_TAG_RE.finditer(tail)
                  if not re.search(r"\bdata-ws-page-script\b", m.group(1))]
        return {"body": body.group(0), "before main": between, "main": main.group(0), "shell scripts": shared}

    def test_every_shell_page_renders_the_same_outside_wspage(self):
        from app.tests.test_shell_contract import SHELL_PAGES
        first = self.outside("index")
        for name in SHELL_PAGES:
            with self.subTest(name):
                self.assertEqual(self.outside(name), first)

    def test_a_page_that_scrolls_whole_scrolls_inside_wspage(self):
        # From lg <main> is one screen tall and hidden overflow; a page that
        # is one long column scrolls #wsPage itself (router.js and wiki.js
        # scroller() pick it), phones scroll the document.
        for name in ("news", "wiki"):
            with self.subTest(name):
                tag = re.search(r'<div id="wsPage"[^>]*>', read(name)).group(0)
                classes = attr(tag, "class").split()
                for c in ("flex-1", "min-h-0", "lg:overflow-y-auto"):
                    self.assertIn(c, classes)

    def test_the_header_keeps_its_height(self):
        # A flex item in <main>'s column: without shrink-0 it gave up height
        # to a page taller than the screen (64 px down to 41).
        part = (STATIC / "partials" / "shell-header.html").read_text(encoding="utf-8")
        tag = re.search(r'<header id="appHeader"[^>]*>', part).group(0)
        self.assertIn("shrink-0", attr(tag, "class").split())


class NotificationsGoThroughTheRouter(unittest.TestCase):
    """The bell's items and a push notification's click move the visitor
    between pages like any link: a soft navigation, so whatever plays in
    #wsPlayer keeps playing (final review I3). The router's side of the
    worker's message runs in app/tests/js/router_runtime.mjs."""

    def test_a_bell_item_navigates_softly(self):
        src = (STATIC / "js" / "notifications.js").read_text(encoding="utf-8")
        start = src.index("var targetUrl = CATEGORY_URLS[n.category] || '/';")
        after = src[start:start + 400]
        self.assertRegex(after, r"if \(window\.WS && WS\.router && typeof WS\.router\.navigate === 'function'\) "
                                r"WS\.router\.navigate\(targetUrl\);\s*else window\.location\.href = targetUrl;")

    def test_a_push_click_asks_an_open_tab_first(self):
        src = (STATIC / "sw.js").read_text(encoding="utf-8")
        code = js_code_only(src)
        start = code.index("function(event) {\n  event.notification.close();")
        click = code[start:matching_brace(code, code.index("{", start)) + 1]
        # The open tab is asked to navigate itself, and answers on a port;
        # only a tab that does not answer is navigated by the worker, and a
        # new window opens only when no tab is open.
        self.assertIn("new MessageChannel()", click)
        self.assertIn("postMessage({ type: 'ws-navigate', url: targetUrl }, [channel.port2])", src)
        self.assertLess(click.index("postMessage("), click.index("client.navigate(targetUrl)"))
        self.assertLess(click.index("client.navigate(targetUrl)"), click.index("openWindow(targetUrl)"))


class PageStartedFullNavigations(unittest.TestCase):
    """A full navigation a page or the shell starts itself (a session that
    ended, a member sent home) goes through the router, so
    ws:before-hard-nav runs first and sub-project 2 has one place to save a
    position (final review M6). Only the fallback for a document without the
    router assigns location itself."""

    FILES = ["js/shell.js", "js/auth.js", "js/notifications.js", "js/news-editor.js"] + \
        sorted(str(p.relative_to(STATIC)) for p in (STATIC / "js" / "pages").glob("*.js"))
    _ASSIGN_RE = re.compile(r"\blocation\.(?:href\s*=(?!=)|replace\(|assign\()")

    def test_every_full_navigation_asks_the_router_first(self):
        for name in self.FILES:
            code = js_code_only((STATIC / name).read_text(encoding="utf-8"))
            with self.subTest(name):
                for line in code.splitlines():
                    if not self._ASSIGN_RE.search(line):
                        continue
                    self.assertTrue(line.strip().startswith("else "), f"{name}: {line.strip()}")

    def test_the_shell_offers_one_way_out(self):
        shell = js_code_only((STATIC / "js" / "shell.js").read_text(encoding="utf-8"))
        body = function_body(shell, "leaveTo")
        self.assertRegex(body, r"if \(WS\.router && typeof WS\.router\.hardNavigate === '        '\) WS\.router\.hardNavigate\(url\);\s*"
                               r"else window\.location\.href = url;")
        self.assertIn("leaveTo: leaveTo,", shell)

    def test_tickets_turned_off_goes_home_softly(self):
        src = module_source("tickets")
        self.assertNotIn("location.replace('/')", js_code_only(src))
        self.assertEqual(src.count("goHome();"), 3)
        self.assertRegex(function_body(js_code_only(src), "goHome"),
                         r"WS\.router\.navigate\('\s', \{ replace: true \}\);\s*else window\.location\.replace\('\s'\);")


class SharedShellScripts(unittest.TestCase):
    """ui.js (the toast and dialog) loads once, from the shell, on every shell
    page; the router closes dialogs before a swap; WS.getJSON takes the page's
    signal (Task 4 fix round 1: U1, D1, R2)."""

    def partial(self):
        return (STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8")

    def test_ui_js_loads_once_from_the_shell_before_the_router(self):
        from app.tests.test_shell_contract import BARE_PAGES, SHELL_PAGES
        part = self.partial()
        tags = [m for m in _SCRIPT_TAG_RE.finditer(part) if "/static/js/ui.js" in (attr(m.group(1), "src") or "")]
        self.assertEqual(len(tags), 1, "the shell partial loads ui.js exactly once")
        a = tags[0].group(1)
        # A plain blocking script: page scripts later in <body> read WSUI at load.
        for word in ("defer", "async", "type"):
            self.assertIsNone(re.search(rf"\b{word}\b", a), f"ui.js must not be {word}")
        self.assertLess(tags[0].start(), part.index("/static/js/router.js"))
        for name in SHELL_PAGES + BARE_PAGES:
            with self.subTest(name):
                self.assertNotIn("/static/js/ui.js", read(name), f"{name} loads ui.js itself")

    def test_router_does_not_fetch_ui_js(self):
        code = js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8"))
        src = (STATIC / "js" / "router.js").read_text(encoding="utf-8")
        self.assertNotIn("ensureUI", code)
        self.assertNotIn("requestIdleCallback", code)
        self.assertNotRegex(src, r"""['"`][^'"`]*ui\.js['"`]""")

    def test_dialogs_close_before_the_page_changes(self):
        ui = js_code_only((STATIC / "js" / "ui.js").read_text(encoding="utf-8"))
        close_all = function_body(ui, "closeDialogs")
        self.assertRegex(close_all, r"while \(stack\.length\) \{\s*var d = topDialog\(\);\s*d\.close\(d\.dismiss\);\s*\}")
        self.assertRegex(ui, r"window\.WSUI = \{[^}]*\bcloseDialogs: closeDialogs\b")
        code = js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8"))
        overlays = function_body(code, "closeOverlays")
        self.assertIn("closeChrome();", overlays)
        self.assertIn("window.WSUI.closeDialogs()", overlays)
        # Before the old page is left (the swap), and before a page claims a URL.
        commit = function_body(code, "commit")
        self.assertLess(commit.index("closeOverlays();"), commit.index("leave();"))
        self.assertEqual(len(re.findall(r"(?<!function )\bcloseOverlays\(\);", code)), 2)
        # The drawer and menus close as the navigation starts (final review
        # I1): one helper, called first thing in visit(). The runtime cases
        # (router_runtime.mjs) cover the order.
        self.assertEqual(code.count("WS.closeChrome()"), 1)
        self.assertIn("WS.closeChrome()", function_body(code, "closeChrome"))

    def test_a_dialogs_listeners_end_when_it_closes(self):
        # Opened from a page, they are that page's; closed, they must be gone,
        # or the page's leak check lists them after it is left.
        ui = js_code_only((STATIC / "js" / "ui.js").read_text(encoding="utf-8"))
        confirm = function_body(ui, "confirm")
        self.assertIn("var ends = new AbortController();", confirm)
        self.assertRegex(function_body(confirm, "close"), r"^\s*if \(done\) return;\s*done = true;\s*ends\.abort\(\);")
        # document's keydown and focusin serve the whole dialog stack and are
        # removed when the last dialog closes; the dialog's own three end with it.
        adds = [n for n in re.findall(r"\b(\w+)\.addEventListener\(", confirm) if n != "document"]
        self.assertEqual(sorted(adds), ["cancel", "ok", "overlay"])
        self.assertRegex(function_body(confirm, "close"), r"document\.removeEventListener\('\s*', onKey, true\);")
        self.assertEqual(len(re.findall(r"\}, \{ signal: ends\.signal \}\);", confirm)), 3)

    def test_get_json_takes_the_pages_signal(self):
        shell = js_code_only((STATIC / "js" / "shell.js").read_text(encoding="utf-8"))
        body = function_body(shell, "getJSON")
        self.assertRegex(shell, r"function getJSON\(url, opts\)")
        self.assertRegex(body, r"var signal = opts && opts\.signal \? opts\.signal : undefined;")
        self.assertRegex(body, r"return fetch\(url, signal \? \{ signal: signal \} : undefined\)\.then\(")
        # Aborts are not swallowed: no catch in getJSON, so the page sees AbortError.
        self.assertNotIn(".catch(", body)
        news = js_code_only(module_source("news"))
        self.assertEqual(len(re.findall(r"WS\.getJSON\([^;]*\{ signal: signal \}\)", news)), 2)
        self.assertEqual(len(re.findall(r"\bgetJSON\(", news)), 2, "every News JSON read goes through WS.getJSON")

    def test_a_rate_limited_page_is_never_read_or_reused(self):
        code = js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8"))
        self.assertIn("r.status < 500 && r.status !== 429 &&", function_body(code, "fetchPage"))
        self.assertIn("if (!res || res.status >= 500 || res.status === 429) res = await fetchPage(", code)


class PageHelpersLoadFirst(unittest.TestCase):
    """A page module may use its helpers from the first line of mount (Settings'
    kit, then signin-rule.js, which extends it): every data-ws-page-script is
    loaded and run, one after another in document order, before the module is
    imported and mounted, on a soft navigation and on a cold load."""

    def test_a_swap_loads_every_helper_before_the_module(self):
        code = js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8"))
        go = function_body(code, "visit")
        load = go.index("await loadPageScripts(doc);")
        imp = go.index("mod = await import(moduleUrl);")
        self.assertLess(load, imp, "helpers load before the module is imported")
        self.assertLess(imp, go.index("await commit(doc, page, dest, mod, moduleUrl, opts, token)"),
                        "and both before the swap that mounts it")
        helpers = function_body(code, "loadPageScripts")
        # One at a time, in the page's order: the next waits for the last.
        self.assertRegex(helpers, r"const list = doc\.querySelectorAll\('[^']*'\);\s*"
                                  r"for \(const s of Array\.prototype\.slice\.call\(list\)\) await loadScript\(")
        self.assertIn("script[data-ws-page-script][src]",
                      (STATIC / "js" / "router.js").read_text(encoding="utf-8"))
        one = function_body(code, "loadScript")
        self.assertIn("el.async = false;", one)
        # Resolved by the element's load event, which fires after it has run.
        self.assertRegex(one, r"el\.addEventListener\('    ', function \(\) \{ resolve\(\); \}, \{ once: true \}\);")

    def test_a_cold_load_runs_the_helpers_before_the_router(self):
        # The router is a module (deferred): it runs, and mounts, after every
        # classic script in the page, so each helper must be a plain one.
        part = (STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8")
        router = [m.group(1) for m in _SCRIPT_TAG_RE.finditer(part) if "/static/js/router.js" in (attr(m.group(1), "src") or "")]
        self.assertEqual(len(router), 1)
        self.assertEqual(attr(router[0], "type"), "module")
        for name in CONVERTED:
            with self.subTest(name):
                h = read(name).split("<template", 1)[0]     # a template's scripts never run on their own
                for m in _SCRIPT_TAG_RE.finditer(h):
                    if not re.search(r"\bdata-ws-page-script\b", m.group(1)):
                        continue
                    for word in ("async", "defer", "type"):
                        self.assertIsNone(re.search(rf"\b{word}\b", m.group(1)), f"{name}: helper is {word}")

    def test_settings_declares_its_rule_after_its_kit(self):
        h = read("settings")
        kit = '<script src="/static/js/settings/kit.js?v=1" data-ws-page-script></script>'
        rule = '<script src="/static/js/settings/signin-rule.js?v=1" data-ws-page-script></script>'
        self.assertEqual((h.count(kit), h.count(rule)), (1, 1))
        self.assertLess(h.index(kit), h.index(rule), "signin-rule.js extends WSSettings: the kit loads first")
        self.assertLess(h.index("</template>"), h.index(kit), "both outside the tab modules' template")


class LeaveGuard(unittest.TestCase):
    """A page can hold its visitor (Settings with unsaved changes): the router
    awaits ctx.beforeLeave's guard before it leaves the page, for a link,
    navigate(), Back and Forward (Task 5). How the router asks, holds Back and
    stays is run for real in app/tests/js/router_runtime.mjs; what is left
    here is the pages' side and the lines whose presence is the point."""

    def code(self):
        return js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8"))

    def test_a_left_page_asks_nothing(self):
        code = self.code()
        self.assertIn("was.guard = null;", function_body(code, "leave"))
        self.assertRegex(code, r"beforeLeave: function \(guard\) \{\s*if \(!entry\.left\) entry\.guard = ")

    def test_a_fragment_entry_the_browser_made_is_marked(self):
        # Back to it from another page must swap this page back in; a page's
        # own entries (a state of their own) are left alone.
        code = self.code()
        m = re.search(r"window\.addEventListener\('\s+', function \(\) \{\s*if \(!current \|\| !samePage\(location\.href, current\.url\)\) return;"
                      r"\s*current\.url = location\.href;\s*if \(history\.state === null\) \{\s*at \+= 1;\s*history\.replaceState\(mark\(", code)
        self.assertIsNotNone(m)

    def test_settings_guards_every_way_out(self):
        page = js_code_only(module_source("settings"))
        self.assertRegex(page, r"ctx\.beforeLeave\(function \(url, how\) \{\s*return Promise\.resolve\(window\.WSSettings\.canLeave\(how\)\)")
        kit = (STATIC / "js" / "settings" / "kit.js").read_text(encoding="utf-8")
        kit_code = js_code_only(kit)
        can = function_body(kit_code, "canLeave")
        self.assertIn("if (S.leaving || S.approved || !anyDirty()) return true;", can)
        self.assertIn("return askLeave()", can)
        # A link asks too (its listener on document runs before the router's
        # on window), then is followed as it would have been.
        self.assertIn("e.preventDefault();\n      askLeave().then(function (ok) {", kit)
        self.assertIn("if (a.isConnected) a.click();", kit)
        self.assertIn("if (!anyDirty() || S.leaving || S.approved) return;", kit)
        # Leave approves; it throws nothing away. The changes go only when the
        # page is really left (end), so a failed destination keeps them, and
        # the approval ends with that navigation (ws:nav-stayed).
        ask = function_body(kit_code, "askLeave")
        self.assertIn("if (ok) S.approved = true;", ask)
        self.assertNotIn("discardAll", ask)
        self.assertIn("discardAll();", function_body(kit_code, "end"))
        self.assertIn("signal.addEventListener('     ', end, { once: true });", function_body(kit_code, "init"))
        self.assertRegex(kit, r"window\.addEventListener\('ws:nav-stayed', function \(\) \{\s*S\.approved = false;")
        self.assertIn("if (!S.leaving && !S.approved && anyDirty())", kit)


# The debug tools (spec 7): a leak checker that wraps addEventListener, the
# timers and fetch, and a page module that throws on purpose. Neither may ever
# load for someone who did not ask for it with ?ws-debug=.
DEBUG_FILES = ("debug-leaks.js", "_debug-throw.js")
_STATIC_IMPORT_RE = re.compile(r"""^\s*import\b[^;(]*?['"][^'"]*debug-leaks\.js""", re.M)
_LITERAL_RE = re.compile(r"""(['"`])([^'"`\n]*debug-leaks\.js[^'"`\n]*)\1""")


class DebugTools(unittest.TestCase):
    def test_debug_code_only_loads_in_debug_mode(self):
        src = (STATIC / "js" / "router.js").read_text(encoding="utf-8")
        self.assertIsNone(_STATIC_IMPORT_RE.search(src), "router.js imports debug-leaks.js statically")
        live = []
        for m in _LITERAL_RE.finditer(src):
            q, body = m.group(1), m.group(2)
            # Inside a comment the stripped source does not end with the blanked literal.
            if not js_code_only(src[:m.end()]).endswith(q + " " * len(body) + q):
                continue
            live.append(m)
            before = js_code_only(src[:m.start()])
            self.assertRegex(before, r"\bimport\s*\(\s*(?:[\w.$]+\s*\(\s*)?$",
                             "debug-leaks.js is named outside a dynamic import(")
            # ...and that import sits in a block entered only in debug mode.
            self.assertRegex(before, r"\bif\s*\([^(){}]*\bdebug\w*[^(){}]*\)\s*\{[^{}]*$",
                             "the debug-leaks.js import is not guarded by the debug check")
        self.assertEqual(len(live), 1, "router.js should import debug-leaks.js in exactly one place")
        self.assertTrue((STATIC / "js" / "debug-leaks.js").is_file())
        self.assertTrue((STATIC / "js" / "pages" / "_debug-throw.js").is_file())

    def test_throw_is_taken_only_where_a_swap_is_about_to_happen(self):
        """takeFlag (the gate itself) is covered in app/tests/js/debug_leaks.mjs.
        Here: the one place go() takes it is after every full-navigation exit
        (an unconverted page, decide() saying "hard"), and only a true result
        replaces the module, so a full navigation never spends the flag and no
        visitor without it ever mounts _debug-throw.js."""
        code = js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8"))
        calls = [m.start() for m in re.finditer(r"\btakeThrow\s*\(", code)
                 if not code[:m.start()].rstrip().endswith("function")]
        self.assertEqual(len(calls), 1, "takeThrow() should be called in exactly one place")
        go = code.index("async function visit(")
        go_end = matching_brace(code, code.index("{", go))
        at = calls[0]
        self.assertTrue(go < at < go_end, "takeThrow() is called outside visit()")
        body = code[go:at]
        for exit_ in ("if (!current)", "if (d.action ===", "await hardNavigate(d.url, token)"):
            self.assertIn(exit_, body, f"takeThrow() is called before the full-navigation exit {exit_!r}")
        self.assertRegex(code[at - 40:at + 80], r"if\s*\(\s*takeThrow\(\)\s*\)\s*moduleUrl\s*=",
                         "only a taken flag may replace the page's module")
        self.assertRegex(code, r"function takeThrow\(\)\s*\{\s*const store = takeFlag\(",
                         "takeThrow() must go through the tested takeFlag() gate")

    def test_no_page_or_shell_script_references_the_debug_files(self):
        files = list(STATIC.glob("*.html")) + list((STATIC / "partials").glob("*.html"))
        files += [p for p in (STATIC / "js").rglob("*.js")
                  if p.name not in ("router.js",) + DEBUG_FILES]
        for path in files:
            text = path.read_text(encoding="utf-8")
            for name in DEBUG_FILES:
                self.assertNotIn(name, text, f"{path.relative_to(STATIC)} references {name}")


# Any HTML event-handler attribute (onclick=, onError=, ...) and any
# javascript: URL: both run script from markup, which script-src 'self' refuses.
_HANDLER_TEXT_RE = re.compile(r"\bon[a-z]+\s*=", re.I)
_JS_URL_RE = re.compile(r"javascript:", re.I)


def html_files():
    return sorted(list(STATIC.glob("*.html")) + list((STATIC / "partials").glob("*.html")))


def js_files():
    return sorted((STATIC / "js").rglob("*.js"))


def own_rule(css: str, selector: str) -> str:
    """The declarations of the rule written for exactly this selector at the
    start of a line (a longer selector ending in it does not count)."""
    found = re.findall(r"(?m)^\s*" + re.escape(selector) + r" \{([^{}]*)\}", css)
    assert len(found) == 1, f"{selector}: {len(found)} rules"
    return found[0]


def string_matches(src: str, pattern) -> list:
    """Matches of pattern that lie inside a JS string or template literal
    (comments and regex literals excluded): the same text is present with the
    strings kept and blank with them blanked."""
    kept = js_code_only(src, keep_strings=True)
    blank = js_code_only(src)
    assert len(kept) == len(blank)
    return [m.group(0) for m in pattern.finditer(kept) if not blank[m.start():m.end()].strip()]


class WholeSite(unittest.TestCase):
    """Task 13, the end state (spec 6 item 11, 7): the CSP is script-src
    'self', so no page may carry an inline script, an inline handler or a
    javascript: URL, including markup a script builds; and the mechanisms soft
    navigation replaced are gone."""

    def test_no_inline_script_anywhere(self):
        # Every page, including login and setup, and the shell partials.
        for path in html_files():
            text = path.read_text(encoding="utf-8")
            with self.subTest(path.name):
                for m in _SCRIPT_TAG_RE.finditer(text):
                    attrs = m.group(1)
                    if attr(attrs, "src"):
                        continue
                    self.assertEqual(attr(attrs, "type"), "application/json",
                                     f"{path.name}: inline <script{attrs}>")
                for tag in _TAG_RE.findall(text):
                    self.assertNotRegex(tag, _HANDLER_ATTR_RE, f"{path.name}: inline handler in {tag[:80]}")
                    self.assertNotRegex(tag, _JS_URL_RE, f"{path.name}: javascript: URL in {tag[:80]}")
        # HTML any script builds, in a string or a template literal.
        for path in js_files():
            src = path.read_text(encoding="utf-8")
            with self.subTest(str(path.relative_to(STATIC))):
                self.assertEqual(string_matches(src, _HANDLER_TEXT_RE), [])
                self.assertEqual(string_matches(src, _JS_URL_RE), [])

    def test_the_string_scan_sees_strings_only(self):
        src = ("el.onclick = f; // onclick=\"x\"\n/* href=\"javascript:\" */ var r = /on[a-z]+=/;\n"
               "var a = '<b onclick=\"x\">'; var b = `<img onerror=${h}>`; var c = \"javascript:void 0\";")
        self.assertEqual(string_matches(src, _HANDLER_TEXT_RE), ["onclick=", "onerror="])
        self.assertEqual(string_matches(src, _JS_URL_RE), ["javascript:"])

    def test_the_data_block_is_json(self):
        try:
            from app import pages
        except ImportError:  # pragma: no cover - the laptop has no FastAPI
            self.skipTest("app.pages needs the container's dependencies")
        block = pages.data_block({}, None, "dev", "news")
        self.assertTrue(block.startswith('<script id="ws-data" type="application/json">'), block[:80])

    def test_login_and_setup_scripts_are_files(self):
        # They stay full-page documents (never router pages): their scripts
        # moved out of the markup, nothing else about them changed.
        for name in ("login", "setup"):
            with self.subTest(name):
                h = read(name)
                self.assertNotIn('id="wsPage"', h)
                self.assertIn(f'<script src="/static/js/{name}.js?v=1"></script>', h)
                self.assertTrue((STATIC / "js" / f"{name}.js").is_file())
        # The login card's branding is applied as soon as the card is parsed,
        # before the first paint: the script is in <main>, after the card.
        login = read("login")
        tag = login.index('<script src="/static/js/login.js?v=1"></script>')
        self.assertLess(login.index('id="authentikLoginBtn"'), tag)
        self.assertLess(tag, login.index("</main>"))

    def test_the_plex_popup_message_is_only_the_popups(self):
        # Any window holding an opener reference to the login tab could post
        # {type:'plex-auth-complete'} and cut a real sign-in short. Only the
        # popup this page opened, on this origin, is heard (plex-callback.js
        # posts to window.location.origin), and the check comes before
        # anything the message does.
        src = (STATIC / "js" / "login.js").read_text(encoding="utf-8")
        code = js_code_only(src)
        start = code.index("window.addEventListener('       ', function handler(e) {")
        body = code[start:matching_brace(code, code.index("{", start))]
        guard = "if (e.origin !== window.location.origin || !popup || e.source !== popup) return;"
        self.assertIn(guard, body)
        for later in ("removeEventListener(", "popup.close()", "finishPlexAuth("):
            self.assertLess(body.index(guard), body.index(later), later)
        self.assertIn("var popup = window.open(", code[:start])
        cb = js_code_only((STATIC / "js" / "plex-callback.js").read_text(encoding="utf-8"))
        self.assertIn("window.location.origin", cb)

    def test_the_form_shows_itself_when_the_script_never_runs(self):
        # login.js is a file now: if it fails to load, nothing adds
        # .auth-ready. The form then shows itself after 2.5 s by CSS alone,
        # with a hint to reload; the normal path (.auth-ready, or login.js
        # having run) cancels both, so nothing changes when the script loads.
        from app.tests.test_motion import keyframe_properties, reduced_blocks
        login = read("login")
        head = login.split("</head>", 1)[0]
        self.assertIn("visibility: hidden", own_rule(head, "#loginForm"))
        self.assertIn("animation: login-fallback-show 0s linear 2.5s forwards",
                      own_rule(head, "html:not([data-login-js]) #loginForm"))
        self.assertEqual(keyframe_properties(head, "login-fallback-show"), {"visibility"})
        self.assertIn("visibility: visible", own_rule(head, "#loginForm.auth-ready"))
        hint = own_rule(head, "#loginLoadHint")
        for decl in ("visibility: hidden", "height: 0", "overflow: hidden",
                     "animation: login-fallback-hint 0s linear 2.5s forwards"):
            self.assertIn(decl, hint)
        self.assertEqual(keyframe_properties(head, "login-fallback-hint"), {"visibility", "height", "margin-top"})
        gone = own_rule(head, "#loginForm.auth-ready ~ #loginLoadHint,\n    html[data-login-js] #loginLoadHint")
        self.assertIn("display: none", gone)
        # A 0 s step, not motion: no reduced-motion block takes it away.
        for block in reduced_blocks(head):
            self.assertNotIn("login-fallback", block)
            self.assertNotIn("#loginForm", block)
            self.assertNotIn("#loginLoadHint", block)
        # The hint is static markup, a later sibling of the form (the ~ rule).
        m = re.search(r'<p id="loginLoadHint"[^>]*>([^<]*)</p>', login)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "Sign-in didn’t load. Reload the page.")
        self.assertLess(login.index("</form>"), m.start())
        self.assertLess(m.start(), login.index('<script src="/static/js/login.js'))
        # Without script the fields must never land in the address bar.
        self.assertRegex(login, r'<form id="loginForm" method="post"')
        # login.js marks the page first thing, before anything that can throw.
        js = js_code_only((STATIC / "js" / "login.js").read_text(encoding="utf-8"))
        first = re.search(r"\S.*", js).group(0)
        blank = " " * len("data-login-js")
        self.assertEqual(first, f"document.documentElement.setAttribute('{blank}', '');")
        self.assertIn("document.documentElement.setAttribute('data-login-js', '');",
                      (STATIC / "js" / "login.js").read_text(encoding="utf-8"))

    def test_the_form_is_usable_whenever_it_shows(self):
        # N1: the form could be shown (by the failsafe) before the page had
        # wired its submit, so Enter did a real POST to /login (405). The
        # handlers are now wired when login.js runs, before any await, and the
        # CSS fallback only applies while login.js has not run at all.
        head = read("login").split("</head>", 1)[0]
        self.assertEqual(own_rule(head, "#loginForm").strip(), "visibility: hidden;")
        fallback = own_rule(head, "html:not([data-login-js]) #loginForm")
        self.assertIn("animation: login-fallback-show 0s linear 2.5s forwards", fallback)
        self.assertEqual(own_rule(head, "#loginForm.auth-ready").strip(), "visibility: visible;")
        src = (STATIC / "js" / "login.js").read_text(encoding="utf-8")
        code = js_code_only(src)
        dcl = code.index("document.addEventListener('                ', async function() {")
        top = code[:dcl]
        # Top level, in order: the marker, the failsafe reveal, the branding,
        # the handlers. Nothing at top level awaits.
        self.assertRegex(top, r"(?m)^setTimeout\(revealForm, REVEAL_AFTER_MS\);$")
        self.assertRegex(top, r"(?m)^wireSignIn\(\);$")
        self.assertNotRegex(re.sub(r"(?ms)^(?:async )?function .*?^\}", "", top), r"\bawait\b")
        wire = function_body(code, "wireSignIn")
        self.assertIn("loginForm.addEventListener('      ', async function(e) {", wire)
        self.assertIn("e.preventDefault();", wire)
        for btn in ("plexLoginBtn", "authentikLoginBtn"):
            self.assertIn(f"var {btn} = document.getElementById(", wire)
        on_ready = code[dcl:matching_brace(code, code.index("{", dcl)) + 1]
        for gone in ("addEventListener('      '", "plexLoginBtn", "authentikLoginBtn"):
            self.assertNotIn(gone, on_ready, "no sign-in wiring left behind an await")
        reveal = function_body(code, "revealForm")
        self.assertIn("f.classList.add('          ');", reveal)
        self.assertIn("revealForm();", on_ready)

    def test_one_plex_pin_is_completed_once(self):
        # N2: the popup's message and the popup-closed poll both completed the
        # same PIN. Each PIN is completed once per page; the message clears the
        # poll; a 409 (the server's claim taken by another call) is ignored.
        code = js_code_only((STATIC / "js" / "login.js").read_text(encoding="utf-8"))
        finish = function_body(code, "finishPlexAuth")
        self.assertRegex(finish, r"if \(plexFinishing\[pinId\]\) return;\s*plexFinishing\[pinId\] = true;\s*completePlexAuth\(pinId\);")
        start = code.index("window.addEventListener('       ', function handler(e) {")
        handler = code[start:matching_brace(code, code.index("{", start))]
        self.assertLess(handler.index("clearInterval(pollInterval);"), handler.index("finishPlexAuth(data.pin_id);"))
        self.assertNotIn("completePlexAuth(", handler)
        poll = code[code.index("var pollInterval = setInterval("):]
        poll = poll[:poll.index("}, 1000);")]
        self.assertIn("finishPlexAuth(data.pin_id);", poll)
        self.assertNotIn("completePlexAuth(", poll)
        complete = function_body(code, "completePlexAuth")
        self.assertRegex(complete, r"if \(resp\.status === 409\) return;")
        # Only finishPlexAuth and completePlexAuth's own retry call it.
        calls = [m.start() for m in re.finditer(r"(?<!function )\bcompletePlexAuth\(", code)]
        self.assertEqual(len(calls), 2, calls)

    def test_old_navigation_removed(self):
        # The router's own hover prefetch replaces the sidebar's speculation
        # rules and the service worker's page cache (spec 5.4).
        for path in html_files():
            with self.subTest(path.name):
                self.assertNotIn("speculationrules", path.read_text(encoding="utf-8"))
        # Cross-document view transitions: no page opts in. The router's own
        # same-document transition keeps the shell's names under html.ws-vt.
        theme = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        self.assertNotIn("@view-transition", theme)
        loader = (STATIC / "js" / "theme-loader.js").read_text(encoding="utf-8")
        self.assertNotRegex(loader, r"addEventListener\('page(swap|reveal)'")
        self.assertRegex(js_code_only(loader), r"window\.WSViewTransition = \{ hold: hold \}")
        # The service worker keeps push and drops the page cache: no cache
        # writes, no fetch or message handling. activate still deletes any
        # ws-pages-* cache a previous worker left.
        sw_src = (STATIC / "sw.js").read_text(encoding="utf-8")
        sw = js_code_only(sw_src)
        for gone in ("caches.open(", ".put(", "respondWith(", "PAGE_CACHE", "prefetched"):
            self.assertNotIn(gone, sw, gone)
        self.assertNotRegex(sw_src, r"addEventListener\('(fetch|message)'")
        for kept in ("install", "activate", "push", "notificationclick"):
            self.assertRegex(sw_src, rf"self\.addEventListener\('{kept}'", kept)
        start = sw_src.index("self.addEventListener('activate'")
        activate = sw_src[start:matching_brace(sw_src, sw_src.index("{", start)) + 1]
        self.assertIn("'ws-pages-'", activate)
        self.assertIn("caches.delete(", activate)
        self.assertEqual(len(live_matches(sw_src, r"'ws-pages-'")), 1, "only the activate cleanup names the old cache")
        # The shell no longer talks to a page cache or speculation rules.
        shell = js_code_only((STATIC / "js" / "shell.js").read_text(encoding="utf-8"))
        for gone in ("PAGE_CACHE", "postMessage", "refreshSpeculation", "wirePrefetch", "wireNav",
                     "caches."):
            self.assertNotIn(gone, shell, gone)


class PlayerView(unittest.TestCase):
    """The audiobook player's mini bar and full player (js/player/ui.js,
    audiobook player spec section 7): document-lifetime like the engine, so
    loaded once by the shell as its own stamped module; no markup from
    strings and no inline handlers (CSP script-src 'self'); styles from the
    theme engine only; reduced motion stills it; the open player covers the
    top bar and stays under the shared toasts and dialogs. Its behaviour is
    app/tests/js/player_ui.mjs."""

    UI = STATIC / "js" / "player" / "ui.js"
    THEME = STATIC / "css" / "theme.css"
    START = "/* ---- Audiobook player (js/player/ui.js) ----"

    def player_css(self) -> str:
        theme = self.THEME.read_text(encoding="utf-8")
        return theme[theme.index(self.START):]

    def test_it_loads_once_from_the_shell_right_after_the_engine(self):
        from app.tests.test_shell_contract import BARE_PAGES, SHELL_PAGES
        part = (STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8")
        tags = [m for m in _SCRIPT_TAG_RE.finditer(part)]
        srcs = [attr(m.group(1), "src") or "" for m in tags]
        ui = [i for i, s in enumerate(srcs) if s.startswith("/static/js/player/ui.js")]
        self.assertEqual(len(ui), 1, "the shell loads the player view exactly once")
        self.assertEqual(srcs[ui[0]], "/static/js/player/ui.js?v=1", "stamped like every shell script")
        self.assertEqual(attr(tags[ui[0]].group(1), "type"), "module")
        self.assertEqual(srcs[ui[0] - 1], "/static/js/player/engine.js?v=1", "right after the engine it draws")
        for name in SHELL_PAGES + BARE_PAGES:
            with self.subTest(name):
                self.assertNotIn("/static/js/player/ui.js", read(name), f"{name} loads the player view itself")
        # Not imported by another module either: an import is unstamped.
        for p in (STATIC / "js").rglob("*.js"):
            self.assertNotRegex(p.read_text(encoding="utf-8"), r"""(?:\bfrom|\bimport\s*\(?)\s*['"][^'"]*player/ui\.js['"]""", p.name)
            if p.parent.name == "player":
                self.assertNotRegex(p.read_text(encoding="utf-8"), r"""(?:\bfrom|\bimport\s*\(?)\s*['"]\./ui\.js['"]""", p.name)

    def test_it_builds_no_markup_from_strings_and_no_handler_properties(self):
        src = self.UI.read_text(encoding="utf-8")
        code = js_code_only(src)
        for word in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "setInterval", "eval("):
            self.assertNotIn(word, code, word)
        self.assertNotRegex(code, r"\.on[a-z]+\s*=(?!=)", "listeners go through addEventListener")
        self.assertEqual(string_matches(src, _HANDLER_TEXT_RE), [])
        # Colours only as classes and theme.css rules: no style colour writes.
        self.assertNotRegex(code, r"\.style\.(?:color|background\w*|border\w*)\s*=")
        # Back and Escape close its layers through the browser's CloseWatcher:
        # it writes no history and asks the router for none.
        self.assertNotRegex(code, r"\bhistory\s*\.|pushState|replaceState|popstate|pushOverlay")
        self.assertIn("new CW()", code)
        # Keys pressed in the full player are handled on it; the only document
        # listener is the capture-phase guard, there while it is open, so a
        # page's own keys (the reader's) never see a key meant for the player.
        kept = js_code_only(src, keep_strings=True)
        self.assertIn("full.addEventListener('keydown', onKey);", kept)
        docs = re.findall(r"(?:doc|document|window|win)\.(?:add|remove)EventListener\('keydown'[^)]*\)", kept)
        self.assertEqual(sorted(docs), ["doc.addEventListener('keydown', onDocKey, true)",
                                        "doc.removeEventListener('keydown', onDocKey, true)"])

    def test_its_styles_are_theme_variables_only(self):
        from app.tests.test_theme_sweep import raw_line_hits
        css = self.player_css()
        self.assertIn(".wsp-bar", css)
        for n, line in enumerate(css.splitlines(), 1):
            with self.subTest(line=n):
                self.assertEqual(raw_line_hits("theme.css", line), [], line)
        # Every colour a rule sets comes from a theme variable.
        for m in re.finditer(r"(?<![\w-])(color|background(?:-color)?|border(?:-top)?|box-shadow)\s*:\s*([^;{}]+)", css):
            prop, value = m.group(1), m.group(2).strip()
            if value in ("transparent", "inherit", "none", "0"):
                continue
            self.assertIn("var(--", value, f"{prop}: {value}")

    def test_reduced_motion_stills_it(self):
        from app.tests.test_motion import stilled
        theme = self.THEME.read_text(encoding="utf-8")
        self.assertTrue(stilled(theme, ".wsp-sheet", "transition"), "the full player's slide")
        for sel in (".wsp-bar", ".wsp-notice", ".wsp-spin"):
            self.assertTrue(stilled(theme, sel, "animation"), sel)
        # The sheet slides on transform only, from below.
        self.assertRegex(theme, r"\.wsp-sheet \{[^}]*transform: translateY\(100%\);[^}]*transition: transform 250ms")
        self.assertRegex(theme, r"\.wsp-full\.is-open \.wsp-sheet \{ transform: none; \}")

    def test_the_open_player_covers_the_top_bar_under_the_dialogs(self):
        theme = self.THEME.read_text(encoding="utf-8")
        lifted = int(re.search(r"html\[data-player-full\] #wsPlayer \{ z-index: (\d+); \}", theme).group(1))
        resting = int(re.search(r"#wsPlayer \{ position: fixed; left: 0; right: 0; bottom: var\(--ws-tabbar-h\); z-index: (\d+); \}", theme).group(1))
        shell = "".join((STATIC / "partials" / f).read_text(encoding="utf-8") for f in ("shell-sidebar.html", "shell-header.html"))
        for el in ("appHeader", "mobileTopBar"):
            tag = re.search(rf'<[^>]*id="{el}"[^>]*>', shell).group(0)
            z = int(re.search(r"\bz-(\d+)\b", tag).group(1))
            self.assertGreater(lifted, z, el)
        # The phone's tab bar too (theme.css), which the resting bar rises from behind.
        tabbar = int(re.search(r"\.ws-tabbar \{[^}]*z-index: (\d+);", theme).group(1))
        self.assertGreater(lifted, tabbar)
        self.assertGreater(tabbar, resting)
        self.assertGreater(resting, 40, "the bar sits over the phone's top bar and the page")
        ui = (STATIC / "js" / "ui.js").read_text(encoding="utf-8")
        for z in re.findall(r"z-\[(\d+)\]", ui):
            self.assertLess(lifted, int(z), "the shared toasts and dialogs stay on top")
        self.assertIn("html[data-player-full] body { overflow: hidden; }", theme)


class PlayerTestPage(unittest.TestCase):
    """The player's test launcher (js/pages/player-test.js, Task 10): its
    one read is on the page's signal; it opens books through WS.player and
    watches the player only for the visit; covers are fitted whole, and one
    that fails gives way to an icon without an inline handler; theme
    colours only. The player it starts is the shell's in the leak tool."""

    def code(self):
        return js_code_only(module_source("player-test"))

    def test_every_request_is_on_the_pages_signal(self):
        code = self.code()
        fetches = [m.start() for m in re.finditer(r"(?<![.\w])fetch\(", code)]
        self.assertEqual(len(fetches), 1, "the book list")
        self.assertIn("signal: signal", ",".join(call_args(code, fetches[0] + len("fetch"))))
        self.assertIn("fetch('/api/player/books', { signal: signal })",
                      module_source("player-test"))
        self.assertNotRegex(code, r"\bgetJSON\(")
        self.assertNotRegex(code, r"(?<![.\w])setTimeout\(|\bsetInterval\(|\bWS\.poll\(")

    def test_it_plays_through_the_player_and_watches_it_for_the_visit(self):
        src = module_source("player-test")
        code = js_code_only(src)
        self.assertIn("p.open(key, { autoplay: true })", code)
        self.assertIn("p.toggle();", code)
        # One subscription, ended when the visit's signal aborts.
        self.assertEqual(len(re.findall(r"\bp\.on\(", code)), 1)
        watch = function_body(code, "watch")
        self.assertIn("unwatch = p.on('      ', sync);", watch)
        self.assertRegex(watch, r"signal\.addEventListener\('     ', function \(\) \{\s*unwatch\(\);\s*done\.abort\(\);\s*\}, \{ once: true, signal: done\.signal \}\);")
        self.assertIn("if (unwatch || !p || signal.aborted) return;", watch)

    def test_covers_are_fitted_whole_and_a_failed_one_needs_no_handler(self):
        src = module_source("player-test")
        self.assertIn("absolute inset-0 size-full object-contain", src)
        self.assertNotIn("object-cover", src)
        self.assertIn("root.addEventListener('error', function (e) {", src)
        self.assertIn("}, { capture: true, signal: signal });", src)

    def test_it_is_not_a_navigation_destination(self):
        from app.settings_registry import PAGE_ADDRESSES
        self.assertNotIn("/player-test", PAGE_ADDRESSES.values())
        for path in html_files() + js_files():
            with self.subTest(str(path.relative_to(STATIC))):
                self.assertNotRegex(path.read_text(encoding="utf-8"), r"""["'(]/player-test""")

    def test_its_text_colours_are_theme_classes(self):
        for text in (read("player-test"), module_source("player-test")):
            self.assertNotRegex(text, r"\btext-(?:slate|gray|zinc|neutral|stone|red|green|blue|yellow|white|black)(?:-\d+)?\b")
            self.assertNotRegex(text, r"#[0-9a-fA-F]{3,8}\b")

    def test_the_player_is_the_shells_in_the_leak_tool(self):
        leaks = (STATIC / "js" / "debug-leaks.js").read_text(encoding="utf-8")
        shell = re.search(r"export const SHELL_FILES = \[([^\]]*)\];", leaks).group(1)
        owned = re.search(r"export const SELF_OWNED_FILES = \[([^\]]*)\];", leaks).group(1)
        for p in sorted((STATIC / "js" / "player").glob("*.js")):
            with self.subTest(p.name):
                self.assertIn(f"'{p.name}'", shell)
                self.assertIn(f"'{p.name}'", owned)


class PlayerFeatures(unittest.TestCase):
    """The audiobook player's listening features (js/player/features.js,
    audiobook player spec section 8): document-lifetime like the engine and
    its view, so loaded once by the shell as its own stamped module after
    ui.js; no markup from strings and no inline handlers (CSP script-src
    'self'); its keys inside the full player through WS.playerUI.onKey, and
    on the page through one document listener in the bubble phase, so a
    page's own handlers (and the player's capture guard) come first. Its
    behaviour is app/tests/js/player_features.mjs."""

    FEATURES = STATIC / "js" / "player" / "features.js"

    def test_it_loads_once_from_the_shell_right_after_the_view(self):
        from app.tests.test_shell_contract import BARE_PAGES, SHELL_PAGES
        part = (STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8")
        tags = [m for m in _SCRIPT_TAG_RE.finditer(part)]
        srcs = [attr(m.group(1), "src") or "" for m in tags]
        mine = [i for i, s in enumerate(srcs) if s.startswith("/static/js/player/features.js")]
        self.assertEqual(len(mine), 1, "the shell loads the features exactly once")
        self.assertEqual(srcs[mine[0]], "/static/js/player/features.js?v=1", "stamped like every shell script")
        self.assertEqual(attr(tags[mine[0]].group(1), "type"), "module")
        self.assertEqual(srcs[mine[0] - 1], "/static/js/player/ui.js?v=1", "right after the view it adds to")
        for name in SHELL_PAGES + BARE_PAGES:
            with self.subTest(name):
                self.assertNotIn("/static/js/player/features.js", read(name), f"{name} loads the features itself")
        for p in (STATIC / "js").rglob("*.js"):
            self.assertNotRegex(p.read_text(encoding="utf-8"),
                                r"""(?:\bfrom|\bimport\s*\(?)\s*['"][^'"]*features\.js['"]""", p.name)

    def test_it_builds_no_markup_from_strings_and_no_handler_properties(self):
        src = self.FEATURES.read_text(encoding="utf-8")
        code = js_code_only(src)
        for word in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "setInterval", "eval("):
            self.assertNotIn(word, code, word)
        self.assertNotRegex(code, r"\.on[a-z]+\s*=(?!=)", "listeners go through addEventListener")
        self.assertEqual(string_matches(src, _HANDLER_TEXT_RE), [])
        self.assertNotRegex(code, r"\.style\.")
        self.assertNotRegex(code, r"\bhistory\s*\.|pushState|replaceState")
        # No WSUI dialog over the player: its choices are panels in it.
        self.assertNotRegex(code, r"WSUI\.(?:confirm|alert|prompt|dialog|open)")

    def test_its_keys_come_after_everyone_else(self):
        kept = js_code_only(self.FEATURES.read_text(encoding="utf-8"), keep_strings=True)
        docs = re.findall(r"(?:doc|document|window|win)\.(?:add|remove)EventListener\('keydown'[^)]*\)", kept)
        self.assertEqual(docs, ["doc.addEventListener('keydown', onDocKey)"], "one listener, in the bubble phase")
        self.assertIn("ui.onKey(", kept, "inside the full player it listens through the view")

    def test_its_controls_are_stilled_by_reduced_motion(self):
        from app.tests.test_motion import stilled
        theme = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        for sel in (".wsp-chip", ".wsp-switch", ".wsp-switch::after", ".wsp-row"):
            self.assertTrue(stilled(theme, sel, "transition"), sel)


class PlayerFindPlace(unittest.TestCase):
    """The audiobook player's "Find your place" helper (js/player/findplace.js,
    spec 2026-09-30 audiobook files changed, section 5): document-lifetime
    like the rest of the player, so loaded once by the shell as its own
    stamped module, right after the features it opens history through; no
    markup from strings and no inline handlers (CSP script-src 'self'); text
    colours only from theme.css. Its behaviour is
    app/tests/js/player_findplace.mjs, run locally and in CI."""

    FINDPLACE = STATIC / "js" / "player" / "findplace.js"

    def test_it_loads_once_from_the_shell_right_after_the_features(self):
        from app.tests.test_shell_contract import BARE_PAGES, SHELL_PAGES
        part = (STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8")
        tags = [m for m in _SCRIPT_TAG_RE.finditer(part)]
        srcs = [attr(m.group(1), "src") or "" for m in tags]
        mine = [i for i, s in enumerate(srcs) if s.startswith("/static/js/player/findplace.js")]
        self.assertEqual(len(mine), 1, "the shell loads the helper exactly once")
        self.assertEqual(srcs[mine[0]], "/static/js/player/findplace.js?v=1", "stamped like every shell script")
        self.assertEqual(attr(tags[mine[0]].group(1), "type"), "module")
        self.assertEqual(srcs[mine[0] - 1], "/static/js/player/features.js?v=1", "right after the features")
        for name in SHELL_PAGES + BARE_PAGES:
            with self.subTest(name):
                self.assertNotIn("/static/js/player/findplace.js", read(name), f"{name} loads the helper itself")
        for p in (STATIC / "js").rglob("*.js"):
            self.assertNotRegex(p.read_text(encoding="utf-8"),
                                r"""(?:\bfrom|\bimport\s*\(?)\s*['"][^'"]*findplace\.js['"]""", p.name)

    def test_it_builds_no_markup_from_strings_and_no_handler_properties(self):
        src = self.FINDPLACE.read_text(encoding="utf-8")
        code = js_code_only(src)
        for word in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "setInterval",
                     "setTimeout", "eval("):
            self.assertNotIn(word, code, word)
        self.assertNotRegex(code, r"\.on[a-z]+\s*=(?!=)", "listeners go through addEventListener")
        self.assertEqual(string_matches(src, _HANDLER_TEXT_RE), [])
        # Colours only through theme.css: the one style write is the nudge's fill.
        self.assertEqual(re.findall(r"\.style\.[\w.]+", code), [".style.setProperty"])
        self.assertNotRegex(code, r"\bhistory\s*\.|pushState|replaceState|popstate")
        self.assertNotRegex(code, r"WSUI\.(?:confirm|alert|prompt|dialog|open)")
        # It reaches the engine only through WS.player's API: it never saves.
        self.assertNotRegex(code, r"\bfetch\(|sendBeacon|localStorage|playerSaves")

    def test_its_controls_are_stilled_by_reduced_motion(self):
        from app.tests.test_motion import stilled
        theme = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        for sel in (".wsp-fp-cand", ".wsp-fp-btn"):
            self.assertTrue(stilled(theme, sel, "transition"), sel)

    def test_its_status_region_is_never_taken_out_of_the_page(self):
        # A live region that is display:none while empty is not announced
        # when it fills (T3F6).
        theme = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        for m in re.finditer(r"([^{}]*\.wsp-fp-status[^{}]*)\{([^{}]*)\}", theme):
            self.assertNotRegex(m.group(2), r"display\s*:\s*none|visibility\s*:\s*hidden", m.group(1).strip())
        code = js_code_only(self.FINDPLACE.read_text(encoding="utf-8"))
        self.assertNotRegex(code, r"setHidden\(status")

    def test_its_status_shows_the_wait_and_the_reason_as_two_lines(self):
        # While a confirm waits, a far spot's reason goes under the wait's
        # line (T3R7): joined by a newline, which only pre-line shows.
        theme = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        m = re.search(r"\.wsp-fp-status\s*\{([^{}]*)\}", theme)
        self.assertIsNotNone(m)
        self.assertRegex(m.group(1), r"white-space\s*:\s*pre-line")

    def test_its_test_runs_locally_and_in_ci(self):
        from app.tests.test_theme_engine import repo_file
        for parts in (("package.json",), (".github", "workflows", "docker-publish.yml")):
            self.assertIn("node app/tests/js/player_findplace.mjs", repo_file(self, *parts), "/".join(parts))


class PlayerSafetyNet(unittest.TestCase):
    """The audiobook player's "Were you listening to one of these?" panel
    (js/player/safetynet.js, spec 2026-10-03 audiobook no lost place, section
    3): document-lifetime like the rest of the player, so loaded once by the
    shell as its own stamped module, right after the helper it leads into; no
    markup from strings, no inline handlers (CSP script-src 'self'), no
    request or storage of its own (it only calls the engine). Its behaviour is
    in app/tests/js/player_findplace.mjs, run locally and in CI."""

    SAFETYNET = STATIC / "js" / "player" / "safetynet.js"

    def test_it_loads_once_from_the_shell_right_after_the_helper(self):
        from app.tests.test_shell_contract import BARE_PAGES, SHELL_PAGES
        part = (STATIC / "partials" / "shell-sidebar.html").read_text(encoding="utf-8")
        tags = [m for m in _SCRIPT_TAG_RE.finditer(part)]
        srcs = [attr(m.group(1), "src") or "" for m in tags]
        mine = [i for i, s in enumerate(srcs) if s.startswith("/static/js/player/safetynet.js")]
        self.assertEqual(len(mine), 1, "the shell loads the safety net exactly once")
        self.assertEqual(srcs[mine[0]], "/static/js/player/safetynet.js?v=1", "stamped like every shell script")
        self.assertEqual(attr(tags[mine[0]].group(1), "type"), "module")
        self.assertEqual(srcs[mine[0] - 1], "/static/js/player/findplace.js?v=1", "right after the helper")
        for name in SHELL_PAGES + BARE_PAGES:
            with self.subTest(name):
                self.assertNotIn("/static/js/player/safetynet.js", read(name), f"{name} loads the safety net itself")
        for p in (STATIC / "js").rglob("*.js"):
            self.assertNotRegex(p.read_text(encoding="utf-8"),
                                r"""(?:\bfrom|\bimport\s*\(?)\s*['"][^'"]*safetynet\.js['"]""", p.name)

    def test_it_is_a_player_file_that_owns_its_listeners(self):
        leaks = (STATIC / "js" / "debug-leaks.js").read_text(encoding="utf-8")
        for name in ("SHELL_FILES", "SELF_OWNED_FILES"):
            with self.subTest(name):
                m = re.search(r"export const %s = \[([^\]]*)\]" % name, leaks)
                self.assertIsNotNone(m)
                self.assertIn("'safetynet.js'", m.group(1))

    def test_it_builds_no_markup_from_strings_and_no_handler_properties(self):
        src = self.SAFETYNET.read_text(encoding="utf-8")
        code = js_code_only(src)
        for word in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "setInterval",
                     "setTimeout", "eval("):
            self.assertNotIn(word, code, word)
        self.assertNotRegex(code, r"\.on[a-z]+\s*=(?!=)", "listeners go through addEventListener")
        self.assertEqual(string_matches(src, _HANDLER_TEXT_RE), [])
        self.assertNotRegex(code, r"\.style\.", "colours only through theme.css")
        self.assertNotRegex(code, r"\bhistory\s*\.|pushState|replaceState|popstate")
        self.assertNotRegex(code, r"\bfetch\(|sendBeacon|localStorage|playerSaves")

    def test_its_cards_borrow_the_helpers_stilled_ones(self):
        from app.tests.test_motion import stilled
        theme = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")
        for sel in (".wsp-fp-cand", ".wsp-fp-btn"):
            self.assertTrue(stilled(theme, sel, "transition"), sel)

    def test_its_test_runs_locally_and_in_ci(self):
        from app.tests.test_theme_engine import repo_file
        for parts in (("package.json",), (".github", "workflows", "docker-publish.yml")):
            self.assertIn("node app/tests/js/player_findplace.mjs", repo_file(self, *parts), "/".join(parts))


if __name__ == "__main__":
    unittest.main()
