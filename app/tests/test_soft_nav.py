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
from app.tests.test_shell_contract import STATIC, js_code_only, matching_brace, read

# Pages converted to soft navigation, in conversion order.
CONVERTED = ["news", "settings", "calendar", "issues", "tickets", "wiki", "index", "library", "reader"]

# Loaded once with the shell and never re-run, so a page never declares them.
SHELL_SCRIPTS = {"theme-loader.js", "auth.js", "shell.js", "ui.js", "notifications.js", "router.js"}

# A page whose module is not named after its file (index.html is Home).
MODULE_NAMES = {"index": "home"}

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
                    self.assertIn(attr(attrs, "type"), ("application/json", "speculationrules"),
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
        # Injected by script they would pile up in <head>, one per visit.
        h = read("tickets")
        self.assertIn(".filter-tab.active, .cat-filter-tab.active {", h[:h.index("</head>")])
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
        go = function_body(code, "go")
        claim = go[go.index("if (!current.left && current.claim) {"):go.index("if (!current.left && current.guard) {")]
        # The entry being left keeps its scroll before the page redraws.
        self.assertLess(claim.index("if (!opts.pop) saveScroll();"), claim.index("current.claim("))
        self.assertIn("const got = current.claim(new URL(target.href), { pop: !!opts.pop, scrollY: opts.scrollY || 0 });", claim)
        # One history write, and the same URL again replaces.
        self.assertRegex(claim, r"if \(opts\.replace \|\| target\.href === location\.href\) history\.replaceState\(st, '', target\.href\);\s*"
                                r"else history\.pushState\(st, '', target\.href\);")
        self.assertEqual(claim.count("history."), 2)
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
        go = function_body(router, "go")
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
                               r"restoreScroll\(y\);\s*if \(!y\) scrollToHash\(new URL\(location\.href\)\);")


class HomePage(unittest.TestCase):
    """Home reads on the page's signal and refreshes through ctx.poll, so no
    gauge, status or section poll outlives a visit; its service list stays the
    one request the header pill shares; its buttons are data-actions on one
    listener; module state is data, never DOM (Task 10)."""

    def code(self):
        return js_code_only(module_source("index"))

    def test_every_read_is_on_the_pages_signal(self):
        code = self.code()
        self.assertEqual(len(re.findall(r"\bgetJSON\(", code)), 4, "news, streams, requests, releases")
        self.assertEqual(len(re.findall(r"WS\.getJSON\([^;]*?, \{ signal: signal \}\)", code)), 4)
        fetches = [m.start() for m in re.finditer(r"(?<![.\w])fetch\(", code)]
        self.assertEqual(len(fetches), 2, "the gauges and the sidebar's request badge")
        for at in fetches:
            self.assertIn("signal: signal", ",".join(call_args(code, at + len("fetch"))), code[at:at + 60])
        # A page left mid-request says nothing and writes nothing.
        self.assertEqual(code.count("if (signal.aborted || isAbort(error)) return;"), 5,
                         "four onError handlers and the gauges' catch")
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
        self.assertIn("export const SELF_OWNED_FILES = ['ui.js', 'shell.js#wireNav', 'shell.js#serviceStatus'];", leaks)

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
        self.assertEqual(sorted(names), ["HOMELAB_ICONS", "NEWS_FRESH_MS", "REQUEST_TONE_CLASSES", "SECTIONS",
                                         "STREAMS_PER_PAGE", "STREAM_CARD_SHAPE"])
        self.assertNotRegex(src, r"^(?:let|var) ", )
        # Every lookup stays inside the page.
        self.assertNotRegex(self.code(), r"\bdocument\.getElementById\(")

    def test_the_buttons_are_data_actions(self):
        h = read("index")
        for action in ("streams-prev", "streams-next"):
            self.assertEqual(h.count(f'data-action="{action}"'), 1, action)
        self.assertNotIn("scrollStreams(", h)
        src = module_source("index")
        self.assertEqual(src.count('data-action="stream-info"'), 1)
        for action in ("streams-prev", "streams-next", "stream-info"):
            self.assertIn(f"case '{action}':", src, action)
        # One listener, on the page, for them and the news cards' Read more.
        code = self.code()
        self.assertEqual(re.findall(r"\b(\w+)\.addEventListener\(", code), ["root"])
        self.assertIn("var toggle = t.closest('[data-news-toggle]');", src)

    def test_sections_follow_the_pages_own_payload(self):
        # The payload of the page the router swapped in, as html[data-home-hide]
        # is (the router copies <html>'s data-* flags on every swap).
        src = module_source("index")
        self.assertIn("var branding = (ctx.data && ctx.data.branding) || window.WEBSERVARR_THEME || {};", src)
        self.assertNotIn("WEBSERVARR_THEME ||", src.replace("window.WEBSERVARR_THEME || {};", ""))
        router = function_body(js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8")), "syncHtmlFlags")
        self.assertIn("if (a.name.indexOf('     ') === 0 && !fresh.hasAttribute(a.name)) root.removeAttribute(a.name);", router)


class LibraryPage(unittest.TestCase):
    """eBooks calls Kavita on the page's signal and times everything with the
    visit; its detail sheet is inside #wsPage; Read opens the reader through
    the router; the guide and the sign-in helper start from mount (Task 11)."""

    def code(self):
        return js_code_only(module_source("library"))

    def test_every_request_is_on_the_pages_signal(self):
        code = self.code()
        fetches = [m.start() for m in re.finditer(r"(?<![.\w])fetch\(", code)]
        self.assertEqual(len(fetches), 2, "the Kavita proxy call and the rating")
        kav = function_body(code, "kavita")
        self.assertIn("if (!options.signal) options.signal = signal;", kav)
        self.assertIn("fetch(url, { credentials: 'include', signal: signal })", module_source("library"))
        # A page left mid-request neither reconnects nor explains.
        self.assertIn("if (!signal.aborted) reconnectKavita();", kav)
        self.assertRegex(function_body(code, "quiet"), r"return signal\.aborted \|\| isAbort\(err\)")

    def test_timers_are_the_pages(self):
        code = self.code()
        self.assertNotRegex(code, r"(?<![.\w])setTimeout\(", "one-off timers go through ctx.setTimeout")
        self.assertNotRegex(code, r"\bWS\.poll\(")

    def test_the_detail_sheet_is_inside_the_page(self):
        h = read("library")
        page = h[h.index('<div id="wsPage"'):h.index("</main>")]
        self.assertEqual(h.count('id="bookDetail"'), 1)
        self.assertIn('<div id="bookDetail" class="hidden fixed inset-0 z-[65] ', page)
        self.assertNotIn("document.body.appendChild", self.code())
        self.assertNotRegex(self.code(), r"\bdocument\.getElementById\(", "lookups stay inside ctx.root")

    def test_read_opens_the_reader_in_this_document(self):
        src = module_source("library")
        self.assertIn("if (window.WS && WS.router && typeof WS.router.navigate === 'function') WS.router.navigate(href);", src)

    def test_a_cover_that_fails_is_hidden_without_an_inline_handler(self):
        src = module_source("library")
        self.assertNotIn("onerror", read("library"))
        self.assertIn("root.addEventListener('error', function (e) {", src)
        self.assertIn("}, { capture: true, signal: signal });", src)

    def test_the_guide_and_the_helper_start_with_the_visit(self):
        src = module_source("library")
        self.assertRegex(src, r"guide = window\.WebServarrTour\.init\(\{[^}]*signal: signal\s*\}\);")
        self.assertNotIn("window.ebooksTour", src)


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
        for sid in ("desktopSidebar", "appHeader", "mobileTopBar", "drawerOverlay", "scrollDownHint", "pageOffBanner"):
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
        self.assertEqual(len(re.findall(r"\bsignal: null,", code)), 1)
        send = function_body(module_source("reader"), "sendProgress")
        self.assertIn("signal: null,\n      keepalive: true,", send)
        self.assertNotRegex(code, r"(?<![.\w])setTimeout\(", "one-off timers go through ctx.setTimeout")
        self.assertIn("saveTimer = ctx.setTimeout(saveProgress, SAVE_DEBOUNCE_MS);", code)

    def test_the_position_is_saved_on_leaving(self):
        # A soft navigation away: the document keeps running, so the last
        # save goes through the writer's leave(), after any write in flight
        # (fix round 2). A hard exit (tab hidden or closed) cannot wait: a
        # beacon, recorded as the newest send.
        code = self.code()
        self.assertRegex(code, r"var leave = function \(\) \{\s*if \(positionKnown\) writer\.leave\(current\.page\);\s*\};")
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
        self.assertIn("return writer.settled().then(fetchProgress)", function_body(code, "restoreProgress"))
        src = module_source("reader")
        self.assertRegex(src, r"export function progressWriter\(send, key\) \{")
        self.assertIn("const progressQueues = new Map();", src)
        self.assertIn("return r.ok;", function_body(code, "sendProgress"))
        # The tab hidden or closed while reading: the beacon, until the visit ends.
        src = module_source("reader")
        self.assertIn("if (document.visibilityState === 'hidden') saveProgress(true);", src)
        self.assertIn("window.addEventListener('pagehide', function () { saveProgress(true); }, { signal: signal });", src)

    def test_it_titles_the_book_through_the_router(self):
        code = self.code()
        self.assertIn("ctx.setTitle(book.title);", code)
        self.assertNotIn("document.title", code)


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
        self.assertNotIn("viewport-fit", read("library"))
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
        self.assertIn("ctx.clearTimeout(searchTimer);", module_source("library"))
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
            self.assertIn("node app/tests/js/reader_progress.mjs", repo_file(self, *parts), "/".join(parts))


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
        self.assertIn("WS.closeChrome()", overlays)
        self.assertIn("window.WSUI.closeDialogs()", overlays)
        # Before the old page is left (the swap), and before a page claims a URL.
        commit = function_body(code, "commit")
        self.assertLess(commit.index("closeOverlays();"), commit.index("leave();"))
        self.assertEqual(len(re.findall(r"(?<!function )\bcloseOverlays\(\);", code)), 2)
        # Nothing closes the chrome alone any more: always with the dialogs.
        self.assertEqual(code.count("WS.closeChrome()"), 1)

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
        go = function_body(code, "go")
        load = go.index("await loadPageScripts(doc);")
        imp = go.index("mod = await import(moduleUrl);")
        self.assertLess(load, imp, "helpers load before the module is imported")
        self.assertLess(imp, go.index("await commit(doc, page, dest, mod, moduleUrl, opts)"),
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
    navigate(), Back and Forward (Task 5)."""

    def code(self):
        return js_code_only((STATIC / "js" / "router.js").read_text(encoding="utf-8"))

    def test_go_asks_the_guard_before_it_fetches(self):
        code = self.code()
        go = function_body(code, "go")
        ask = go.index("verdict = await current.guard(new URL(target.href), { pop: !!opts.pop });")
        self.assertLess(go.index("if (!current) {"), ask, "an unconverted page has no guard to ask")
        self.assertLess(go.index("current.claim(new URL(target.href), "), ask, "an in-page URL is not a leave")
        self.assertLess(ask, go.index("takePrefetch(target.href)"), "asked before any fetch")
        after = go[ask:go.index("takePrefetch(target.href)")]
        self.assertIn("if (token !== navToken) return;", after, "a newer navigation wins over an answer")
        stay = re.search(r"if \(verdict === false\) \{(.*?)\n      \}", after, re.S)
        self.assertIsNotNone(stay)
        # Back or Forward already moved the address bar: a stay puts it back.
        self.assertIn("if (opts.pop) history.replaceState(", stay.group(1))
        self.assertIn("current.url);", stay.group(1))
        self.assertRegex(after, r"if \(verdict === '    '\) \{[^}]*await hardNavigate\(target\.href, token\);")
        self.assertIn("if (verdict === 'hard') {", (STATIC / "js" / "router.js").read_text(encoding="utf-8"))

    def test_a_left_page_asks_nothing(self):
        code = self.code()
        self.assertIn("was.guard = null;", function_body(code, "leave"))
        self.assertRegex(code, r"beforeLeave: function \(guard\) \{\s*if \(!entry\.left\) entry\.guard = ")

    def test_a_fragment_entry_the_browser_made_is_marked(self):
        # Back to it from another page must swap this page back in; a page's
        # own entries (a state of their own) are left alone.
        code = self.code()
        m = re.search(r"window\.addEventListener\('\s+', function \(\) \{\s*if \(!current \|\| !samePage\(location\.href, current\.url\)\) return;"
                      r"\s*current\.url = location\.href;\s*if \(history\.state === null\) history\.replaceState\(\{ ws: 1,", code)
        self.assertIsNotNone(m)

    def test_another_back_waits_while_the_guard_is_asked(self):
        # Back, Back while "Leave without saving?" is open: the second step
        # neither skips the question (a same-page /settings entry) nor starts
        # a navigation; the address stays on the entry the question is about.
        code = self.code()
        go = function_body(code, "go")
        self.assertIn("const ask = asking = { url: opts.pop ? target.href : location.href };", go)
        self.assertRegex(go, r"\} finally \{\s*if \(asking === ask\) asking = null;\s*\}")
        pop = re.search(r"window\.addEventListener\('\s+', function \(e\) \{\s*const st = e\.state;(.*?)\n  \}\);", code, re.S)
        self.assertIsNotNone(pop)
        body = pop.group(1)
        held = body.index("if (asking) {")
        self.assertLess(held, body.index("samePage(location.href, current.url)"), "held before the same-page shortcut")
        self.assertLess(held, body.index("go(location.href"), "and before any navigation")
        self.assertRegex(body, r"if \(asking\) \{\s*history\.replaceState\(\{ ws: 1, scrollY: 0 \}, '', asking\.url\);\s*return;\s*\}")

    def test_a_stay_after_a_let_through_leave_is_announced(self):
        code = self.code()
        stay = re.search(r"if \(d\.action === '    '\) \{(.*?)\n    \}", function_body(code, "go"), re.S)
        self.assertIsNotNone(stay)
        self.assertIn("window.dispatchEvent(new CustomEvent('", stay.group(1))
        self.assertIn("ws:nav-stayed", (STATIC / "js" / "router.js").read_text(encoding="utf-8"))

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
        go = code.index("async function go(")
        go_end = matching_brace(code, code.index("{", go))
        at = calls[0]
        self.assertTrue(go < at < go_end, "takeThrow() is called outside go()")
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


if __name__ == "__main__":
    unittest.main()
