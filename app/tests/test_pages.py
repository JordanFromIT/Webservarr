"""
Server-side page rendering (app/pages.py).

The shell arrives in the HTML for the signed-in user; the head carries the
theme, the display font and the JSON data block the client reads instead of
fetching. These tests pin the contract and the escaping.
"""
import json
import os
import re
import tempfile
import unittest
from unittest import mock

from app import pages
from app.pages import NAV_ITEMS, PAGE_NAV, asset_stamp, render_html
from app.routers.branding import build_branding
from app.tests.test_shell_contract import FORBIDDEN_STRINGS, js_code_only, live_matches, matching_brace

def setUpModule():
    # The partials live next to the pages; resolve them relative to this file
    # so the suite runs from a checkout as well as from /app in the container.
    pages.STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")


PAGE = (
    '<!DOCTYPE html><html class="dark" lang="en"><head><meta charset="utf-8"/>'
    '<title>WebServarr - Control Center</title>'
    '<script src="/static/js/theme-loader.js"></script>'
    '<link href="/static/css/app.css?v=1" rel="stylesheet"/></head>'
    '<body><!-- ws:sidebar --><main><!-- ws:header --><p>hi</p></main></body></html>'
)

ADMIN = {"username": "root", "display_name": "", "is_admin": True,
         "avatar_url": "/static/a.png", "auth_method": "simple"}
MEMBER = {"username": "sam", "display_name": "Sam <b>", "is_admin": False,
          "avatar_url": "", "auth_method": "plex"}


def branding(**overrides):
    return build_branding(overrides, {}, None, {"tickets": None, "issues": None, "playback": None})


def render(user=ADMIN, name="index", b=None, flags=None, page=PAGE):
    return render_html(page, name=name, branding=b or branding(), user=user, version="9.9.9",
                       base_url="https://example.test", path="/", flags=flags or {})


def data_of(out):
    m = re.search(r'<script id="ws-data" type="application/json">(.*?)</script>', out, re.S)
    return json.loads(m.group(1))


def html_tag(out):
    return out.split("<head>")[0]


def static_text(*parts):
    with open(os.path.join(pages.STATIC_DIR, *parts), encoding="utf-8") as f:
        return f.read()


# Each Home loader and the section switch that must guard every call to it.
# None: the call is not a home section and must stay unguarded.
HOME_LOADERS = {
    "loadNews": "news",
    "loadServices": "services",
    "loadSystemStats": "services",
    "loadActiveStreams": "streams",
    "loadRecentRequests": "requests",
    "loadUpcomingReleases": "releases",
    "loadRequestCount": None,
}


def home_guard_problems(page: str) -> list:
    """What is wrong with how Home's page module (pages/home.js) gates loads
    in mount(ctx).

    Works on live code only (js_code_only / live_matches), so neither a
    comment nor a string can stand in for a guard or a call. Raw-source
    positions are mapped into the code-only text by measuring the code-only
    form of the source before them. Calls inside a named function that mount
    declares (a loader, the stream pager) are that function's business, not
    the page's load order, and are not checked."""
    raw = page
    code = js_code_only(raw)

    def at(p):
        return len(js_code_only(raw[:p]))

    def only(pattern):
        found = live_matches(raw, pattern)
        return found[0] if len(found) == 1 else None

    problems = []
    start = only(r"export async function mount\(ctx\)\s*\{")
    if start is None:
        return ["mount(ctx) is not live code"]
    h_open = at(start.end()) - 1
    h_close = matching_brace(code, h_open)

    def in_handler(c):
        return h_open < c < h_close

    decls = []
    for m in live_matches(raw, r"\bfunction\s+\w+\s*\([^)]*\)\s*\{"):
        o = at(m.end()) - 1
        if in_handler(o):
            decls.append((at(m.start()), matching_brace(code, o)))

    def in_decl(c):
        return any(a <= c <= b for a, b in decls)

    # sectionOn reads the page's own payload and treats anything but false as
    # on; the sections that are off are marked arrived before the wait on
    # checkAuth.
    for pattern in (r"var branding = \(ctx\.data && ctx\.data\.branding\) \|\| window\.WEBSERVARR_THEME \|\| \{\};",
                    r"var homeSections = branding\.home_sections \|\| \{\};",
                    r"function sectionOn\(id\) \{ return homeSections\[id\] !== false; \}"):
        if only(pattern) is None:
            problems.append("missing live: " + pattern)
    arrive = only(r"if \(!sectionOn\(id\)\) WS\.arrive\(id\);")
    auth = only(r"await checkAuth\(\)")
    if arrive is None or auth is None or not arrive.start() < auth.start():
        problems.append("off sections are not marked arrived before checkAuth")

    # Guard spans: `if (sectionOn('x')) stmt;` or `if (sectionOn('x')) { ... }`.
    guards = []
    for m in live_matches(raw, r"if\s*\(\s*sectionOn\(\s*'(\w+)'\s*\)\s*\)\s*"):
        e = at(m.end())
        end = matching_brace(code, e) if code[e] == "{" else code.index(";", e)
        guards.append((m.group(1), e, end))

    def guard_of(c):
        inside = [g for g in guards if g[1] <= c <= g[2]]
        return min(inside, key=lambda g: g[2] - g[1])[0] if inside else None

    # ctx.poll(..., interval) spans inside the handler.
    polls = []
    for m in live_matches(raw, r"ctx\.poll\("):
        o = at(m.end()) - 1
        if not in_handler(o):
            continue
        depth = 0
        for close in range(o, len(code)):
            depth += {"(": 1, ")": -1}.get(code[close], 0)
            if depth == 0:
                break
        interval = re.search(r",\s*(\d+)\s*\)$", code[o:close + 1])
        polls.append((int(interval.group(1)) if interval else None, o, close))

    def poll_of(c):
        return next((p[0] for p in polls if p[1] < c < p[2]), None)

    seen = set()
    for m in live_matches(raw, r"\b(" + "|".join(HOME_LOADERS) + r")\b(?=\s*[(,])"):
        c = at(m.start())
        if not in_handler(c) or in_decl(c):
            continue
        name = m.group(1)
        want, got = HOME_LOADERS[name], guard_of(c)
        if got != want:
            problems.append(f"{name} guarded by {got!r}, expected {want!r}")
        seen.add((name, poll_of(c)))

    for name in HOME_LOADERS:
        if (name, None) not in seen:
            problems.append(f"{name} is not in the initial load")
    for name in ("loadServices", "loadActiveStreams", "loadRecentRequests",
                 "loadUpcomingReleases", "loadRequestCount"):
        if (name, 30000) not in seen:
            problems.append(f"{name} is not in the 30 s poll")
    if ("loadSystemStats", 1000) not in seen:
        problems.append("loadSystemStats is not polled every second")

    intervals = sorted(p[0] or 0 for p in polls)
    if intervals != [1000, 1000, 30000]:
        problems.append(f"unexpected polls {intervals}")
    for interval, o, _ in polls:
        if interval == 1000 and guard_of(o) != "services":
            problems.append("a 1 s poll runs outside the sectionOn('services') block")
    return problems


def function_text(src: str, signature: str) -> str:
    """The raw source of the function that starts at signature, through its
    closing brace, comments and strings included. The brace is matched in
    js_code_only space (so no brace in a comment or string counts); the start
    end is then taken back to a raw position. Comments are deleted, not
    blanked, so a code-space length is no raw length: the raw end is the first
    raw "}" whose prefix, in code-only form, is exactly the code up to and
    including the matched brace (a "}" in a comment or a string never is)."""
    text = src[src.index(signature):]
    code = js_code_only(text)
    want = code[:matching_brace(code, code.index("{")) + 1]
    for i, ch in enumerate(text):
        if ch == "}" and js_code_only(text[:i + 1]) == want:
            return text[:i + 1]
    raise AssertionError(f"no end found for {signature!r}")


def css_rules(css: str) -> dict:
    """{selector: {property: value}} for the plain rules in a stylesheet."""
    rules = {}
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", re.sub(r"/\*.*?\*/", "", css, flags=re.S)):
        decls = dict((k.strip(), v.strip()) for k, v in
                     (d.split(":", 1) for d in m.group(2).split(";") if ":" in d))
        for sel in m.group(1).split(","):
            rules.setdefault(" ".join(sel.split()), {}).update(decls)
    return rules


class ShellRendering(unittest.TestCase):
    def test_sidebar_and_header_replace_markers(self):
        out = render()
        self.assertNotIn("ws:sidebar", out)
        self.assertNotIn("ws:header", out)
        self.assertIn('id="desktopSidebar"', out)
        self.assertIn('id="appHeader"', out)
        self.assertIn('title="Notifications"', out)
        self.assertRegex(out, r'<header[^>]*class="[^"]*lg:flex')

    def test_active_item_is_marked(self):
        out = render(name="calendar")
        self.assertRegex(out, r'<a[^>]*href="/calendar"[^>]*aria-current="page"')
        self.assertNotRegex(out, r'<a[^>]*href="/issues"[^>]*aria-current="page"')
        # The news archive lives under Home.
        self.assertRegex(render(name="news"), r'<a[^>]*href="/"[^>]*aria-current="page"')

    def test_admin_only_items_emitted_only_for_admins(self):
        def nav(out):
            return re.search(r'<nav id="desktopNav".*?</nav>', out, re.S).group(0)
        self.assertIn('href="/settings"', nav(render(user=ADMIN)))
        self.assertNotIn('href="/settings"', nav(render(user=MEMBER)))
        # The account-menu entry stays in the markup but hidden for members.
        self.assertRegex(render(user=MEMBER), r'<a href="/settings#sign-in" class="[^"]*hidden">')
        self.assertIn("data-admin", html_tag(render(user=ADMIN)))
        self.assertNotIn("data-admin", html_tag(render(user=MEMBER)))
        # Version label and the account-settings menu entry hide for members.
        self.assertIn('id="appVersion" class="text-steel-blue text-[10px] text-center ">v9.9.9', render(user=ADMIN))
        self.assertIn('id="appVersion" class="text-steel-blue text-[10px] text-center hidden">v9.9.9', render(user=MEMBER))

    def test_page_switches_and_retired_flags(self):
        b = branding(**{"sidebar.enabled_tickets": "false", "sidebar.enabled_calendar": "false"})
        out = render(b=b)
        self.assertNotIn('href="/tickets"', out)
        self.assertNotIn('href="/calendar"', out)
        self.assertIn('href="/issues"', out)
        # Retired flags no longer do anything.
        out = render(b=branding(**{"features.show_tickets": "false", "features.show_requests": "true"}))
        self.assertIn('href="/tickets"', out)
        self.assertNotIn('href="/requests-embed"', out)
        # The pending-requests badge lives on the one Requests item.
        self.assertRegex(render(), r'href="/requests"[^\n]*data-badge="requestsBadge"')

    def test_shell_has_no_duplicate_ids(self):
        # The nav links fill both the desktop sidebar and the phone drawer, so
        # anything with an id inside a link would appear twice, and
        # getElementById would only ever find the first (hidden on a phone).
        # Worst case: every page visible, every New! flag on, and both label
        # layouts (with a sublabel line, and without one). The admin's "this
        # page is turned off" banner is part of the shell too, so one render
        # carries it.
        from app.settings_registry import SIDEBAR_PAGE_IDS
        on = {"integration.kavita.url": "http://192.168.1.50:5000"}
        on.update({"sidebar.new_" + pid: "true" for pid in SIDEBAR_PAGE_IDS})
        no_sub = dict(on, **{"sidebar.sublabel_" + pid: "" for pid in SIDEBAR_PAGE_IDS})
        for name, values, flags in (("with sublabels", on, {}), ("without sublabels", no_sub, {}),
                                    ("page switched off", on, {"page_off": True})):
            with self.subTest(name):
                b = branding(**values)
                for pid in SIDEBAR_PAGE_IDS:
                    self.assertTrue(b["sidebar_enabled"][pid], pid)
                    self.assertTrue(b["sidebar_new"][pid], pid)
                out = render(user=ADMIN, b=b, flags=flags)
                self.assertEqual('id="pageOffBanner"' in out, bool(flags.get("page_off")))
                nav = re.search(r'<nav id="drawerNav".*?</nav>', out, re.S).group(0)
                self.assertEqual(len(re.findall(r"<a ", nav)), 8)      # every page is in the nav
                self.assertEqual(nav.count('class="nav-new-badge"'), 8)
                ids = re.findall(r'''\sid=["']([^"']+)["']''', out)
                dupes = sorted({i for i in ids if ids.count(i) > 1})
                self.assertEqual(dupes, [])

    def test_labels_icons_sublabels_and_new_flag_apply(self):
        b = branding(**{"sidebar.label_issues": "Problems", "icon.nav_issues": "bug_report",
                        "sidebar.sublabel_issues": "", "sidebar.new_issues": "true"})
        out = render(b=b)
        self.assertIn("Problems", out)
        self.assertIn(">bug_report<", out)
        self.assertIn('class="nav-new-badge"', out)
        # Empty sublabel means "no second line" for that item.
        self.assertRegex(out, r'href="/issues"[^\n]*<span>Problems<span class="nav-new-badge">New!</span></span>')

    def test_new_flag_sits_outside_the_truncating_label(self):
        # truncate is overflow:hidden and the flag paints taller than its line,
        # so a flag inside the truncating span gets its top and bottom clipped.
        b = branding(**{"sidebar.label_issues": "Problems", "sidebar.sublabel_issues": "Tell us",
                        "sidebar.new_issues": "true"})
        out = render(b=b)
        self.assertRegex(out, r'href="/issues"[^\n]*<span class="truncate">Problems</span>'
                              r'<span class="nav-new-badge">New!</span>')
        self.assertNotRegex(out, r'<span class="truncate">[^<]*<span class="nav-new-badge">')

    def test_user_strings_are_escaped_and_bad_avatar_dropped(self):
        out = render(user=MEMBER)
        self.assertIn("Sam &lt;b&gt;", out)
        self.assertNotIn("Sam <b>", out)
        self.assertIn("background-image:url(/static/a.png);", render(user=ADMIN))
        tricky = dict(ADMIN, avatar_url="https://x.test/a b')(.png")
        self.assertIn("background-image:url(https://x.test/a%20b%27%29%28.png);", render(user=tricky))
        self.assertEqual(pages.public_user({"avatar_url": "javascript:alert(1)"})["avatar_url"], "")
        self.assertEqual(pages.public_user({"avatar_url": "//evil/x.png"})["avatar_url"], "")
        self.assertEqual(pages.public_user({"avatar_url": "https://plex.tv/u.png"})["avatar_url"], "https://plex.tv/u.png")

    def test_public_user_says_whether_push_can_reach_the_account(self):
        self.assertTrue(pages.public_user({"email": "Sam@Example.test"})["has_email"])
        for email in ("", "  ", "None", "none", None):
            self.assertFalse(pages.public_user({"email": email})["has_email"], repr(email))
        self.assertFalse(pages.public_user({"username": "kid"})["has_email"])
        # The flag only: the address itself never reaches the page.
        user = pages.public_user({"email": "sam@example.test"})
        self.assertNotIn("sam@example.test", json.dumps(user))

    def test_public_user_carries_an_opaque_identity_key(self):
        # The player keys its local copy of a listener's place by account
        # identity (never the username, which can collide), but the page only
        # ever gets an HMAC of it: a Plex account id must not sit in page
        # data or storage keys on a shared family device.
        import asyncio
        from app.config import settings
        from app.routers.simple_auth import check_session
        from app.utils import identity_key
        plex = {"auth_method": "plex", "user_id": "48151623", "plex_account_id": "48151623", "username": "sam"}
        linked = {"auth_method": "oidc", "user_id": "sub-1", "plex_account_id": "48151623", "plex_token": "t"}
        local = {"auth_method": "simple", "account_uid": "u-9", "username": "sam"}
        other = {"auth_method": "plex", "user_id": "5", "plex_account_id": "5", "username": "sam"}
        with mock.patch.object(settings, "app_secret_key", "test-secret-one"):
            k = pages.public_user(plex)["identity_key"]
            self.assertRegex(k, r"^[0-9a-f]{24}$")
            self.assertEqual(k, identity_key("plex:48151623"))
            # Stable for one identity, however it signed in; different across identities.
            self.assertEqual(pages.public_user(dict(plex))["identity_key"], k)
            self.assertEqual(pages.public_user(linked)["identity_key"], k)
            keys = {k, pages.public_user(local)["identity_key"], pages.public_user(other)["identity_key"]}
            self.assertEqual(len(keys), 3)
            # Never the raw identity, nor containing it.
            for key in keys:
                self.assertNotIn("48151623", key)
                self.assertNotIn("plex:", key)
            self.assertNotIn("identity", pages.public_user(plex))
            # No identity: no key.
            self.assertEqual(pages.public_user({"auth_method": "simple", "username": "sam"})["identity_key"], "")
            # Neither the page data nor check-session carries the raw id.
            out = render(user=pages.public_user(plex))
            data = data_of(out)
            self.assertEqual(data["user"]["identity_key"], k)
            self.assertNotIn("48151623", out)
            answer = asyncio.run(check_session(current_user=plex))
            self.assertEqual(answer["user"]["identity_key"], k)
            self.assertNotIn("identity", answer["user"])
            self.assertNotIn("48151623", json.dumps(answer))
        # Keyed by the app's secret: another install gives another key.
        with mock.patch.object(settings, "app_secret_key", "test-secret-two"):
            self.assertNotEqual(pages.public_user(plex)["identity_key"], k)
        # Before the secret is loaded there is no key rather than an unkeyed hash.
        with mock.patch.object(settings, "app_secret_key", ""):
            self.assertEqual(pages.public_user(plex)["identity_key"], "")

    def test_app_name_is_escaped_in_shell(self):
        out = render(b=branding(**{"branding.app_name": "A & B <x>"}))
        self.assertIn("A &amp; B &lt;x&gt;", out)
        self.assertNotIn("<x>", out.split("<body>")[1])

    def test_head_gets_theme_font_and_data(self):
        out = render()
        self.assertIn('<style id="ws-theme">', out)
        self.assertIn("--color-primary:18 87 147", out)
        self.assertIn('--font-display:"Spline Sans",sans-serif', out)
        self.assertIn('<link id="ws-font" rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Spline+Sans', out)
        self.assertIn('rel="preconnect" href="https://fonts.gstatic.com" crossorigin', out)
        # optional, never swap: a swap re-lays out the page when the font lands.
        self.assertRegex(out, r'<link id="ws-font" rel="stylesheet" href="[^"]*&amp;display=optional"')
        self.assertNotIn("display=swap", out)
        data = data_of(out)
        self.assertEqual(data["user"]["username"], "root")
        self.assertIs(data["user"]["is_admin"], True)
        self.assertEqual(data["version"], "9.9.9")
        self.assertEqual(data["page"], "index")
        self.assertEqual(data["branding"]["app_name"], "WebServarr")
        self.assertIn("auth_methods", data["branding"])

    def test_custom_colours_and_font_are_inlined(self):
        b = branding(**{"theme.color_primary": "#ff0000", "theme.font": "Inter"})
        out = render(b=b)
        self.assertIn("--color-primary:255 0 0", out)
        self.assertIn("--hex-primary:#ff0000", out)
        self.assertIn("family=Inter:wght", out)
        self.assertIn('--font-display:"Inter",sans-serif', out)

    def test_data_block_cannot_close_itself(self):
        b = branding(**{"branding.app_name": "</script><script>alert(1)</script>"})
        out = render(b=b)
        block = re.search(r'<script id="ws-data" type="application/json">(.*?)</script>', out, re.S).group(1)
        self.assertNotIn("</script", block)
        self.assertIn("\\u003c/script", block)
        self.assertEqual(data_of(out)["branding"]["app_name"], "</script><script>alert(1)</script>")

    def test_invalid_colour_and_font_fall_back(self):
        b = branding(**{"theme.color_primary": "red; } body{display:none",
                        "theme.font": 'Evil"; @import'})
        out = render(b=b)
        self.assertIn("--color-primary:18 87 147", out)
        self.assertIn("family=Spline+Sans", out)
        # The whole head, the #ws-data block included: theme-loader applies
        # that block's font and colours inline, so it carries the safe values too.
        head = out.split("<body>")[0]
        self.assertNotIn("@import", head)
        self.assertNotIn("body{display", head)
        data = data_of(out)["branding"]
        self.assertEqual(data["font"], "Spline Sans")
        self.assertEqual(data["colors"]["primary"], "#125793")

    def test_ws_data_precedes_theme_loader(self):
        out = render()
        self.assertLess(out.index('id="ws-data"'), out.index("theme-loader.js"))

    def test_title_rewrite_and_og_kept(self):
        out = render(b=branding(**{"branding.app_name": "My Server"}))
        self.assertIn("<title>My Server - Control Center</title>", out)
        self.assertIn('property="og:site_name" content="My Server"', out)
        self.assertIn('property="og:url" content="https://example.test/"', out)

    def test_link_preview_image_ignores_svg_with_query_or_fragment(self):
        for svg in ("/icons.svg#logo", "/x/LOGO.SVG?v=2"):
            with self.subTest(logo=svg):
                out = render(b=branding(**{"branding.logo_url": svg}))
                self.assertNotIn('property="og:image"', out)
                self.assertIn('name="twitter:card" content="summary"', out)
        out = render(b=branding(**{"branding.logo_url": "/static/uploads/logo.png?v=2"}))
        self.assertIn('property="og:image" content="https://example.test/static/uploads/logo.png?v=2"', out)
        out = render(b=branding(**{"branding.logo_url": "HTTPS://cdn.example.com/l.png"}))
        self.assertIn('property="og:image" content="HTTPS://cdn.example.com/l.png"', out)

    def test_html_attributes(self):
        self.assertIn('data-page="index"', html_tag(render()))
        self.assertIn("data-netdata", html_tag(render(flags={"netdata": True})))
        self.assertNotIn("data-netdata", html_tag(render(flags={"netdata": False})))

    def test_pages_without_markers_are_left_alone(self):
        page = "<html><head><title>WebServarr - Login</title></head><body>x</body></html>"
        out = render(user=None, name="login", page=page)
        self.assertNotIn("desktopSidebar", out)
        self.assertIsNone(data_of(out)["user"])
        self.assertIn('data-page="login"', html_tag(out))

    def test_logo_falls_back_to_icon_when_url_is_unsafe(self):
        out = render(b=branding(**{"branding.logo_url": "javascript:x", "icon.sidebar_logo": "dns"}))
        self.assertNotIn("javascript:", out.split("<body>")[1])
        self.assertIn(">dns<", out)
        out = render(b=branding(**{"branding.logo_url": "/static/uploads/logo.png"}))
        self.assertIn('<img src="/static/uploads/logo.png" alt="Logo"', out)

    def test_every_page_mapping_targets_a_nav_item(self):
        ids = {i["id"] for i in NAV_ITEMS}
        for page, nav in PAGE_NAV.items():
            self.assertIn(nav, ids, page)

    def test_home_sections_switched_off_are_listed_on_html(self):
        b = branding(**{"home.section_news": "false", "home.section_streams": "false"})
        self.assertIn('data-home-hide="news streams"', html_tag(render(b=b, name="index")))
        self.assertNotIn("data-home-hide", html_tag(render(name="index")))
        self.assertNotIn("data-home-hide", html_tag(render(b=b, name="calendar")))

    def test_only_the_reader_hides_the_shell(self):
        # A full-screen view: the shell is rendered (so #wsPlayer is there and
        # the router can swap back out) but marked hidden on <html>.
        out = render(name="reader")
        self.assertIn(' data-shell="hidden"', html_tag(out))
        self.assertIn('id="wsPlayer"', out)
        self.assertIn('id="desktopSidebar"', out)
        for name in ("index", "books", "news", "login"):
            self.assertNotIn("data-shell", html_tag(render(name=name)), name)

    def test_index_skips_sections_that_are_off(self):
        self.assertEqual(home_guard_problems(static_text("js", "pages", "home.js")), [])

    def test_home_guard_check_rejects_unguarded_loads(self):
        # Each mutation still passes a plain substring check for "sectionOn(";
        # the live-code check must not.
        page = static_text("js", "pages", "home.js")
        guard = r"if \(sectionOn\('\w+'\)\) "
        self.assertTrue(re.search(guard, page), "the guards this test mutates are gone")
        reverted = re.sub(guard, "", page)                  # every call unconditional
        commented = re.sub(guard, lambda m: "/* " + m.group(0) + "*/ ", page)
        for name, mutated in (("reverted", reverted), ("commented", commented)):
            self.assertIn("sectionOn(", mutated)
            problems = home_guard_problems(mutated)
            for loader in ("loadNews", "loadServices", "loadSystemStats", "loadActiveStreams",
                           "loadRecentRequests", "loadUpcomingReleases"):
                self.assertTrue(any(p.startswith(loader + " guarded by None") for p in problems),
                                (name, loader, problems))
            self.assertIn("a 1 s poll runs outside the sectionOn('services') block", problems, name)
        self.assertEqual(page.count("first.push(loadRequestCount());   //"), 1)
        badge = page.replace("first.push(loadRequestCount());   //",
                             "if (sectionOn('requests')) first.push(loadRequestCount());   //", 1)
        self.assertIn("loadRequestCount guarded by 'requests', expected None", home_guard_problems(badge))

    def test_home_section_css_is_scoped_to_the_hide_attribute(self):
        rules = css_rules(static_text("css", "theme.css"))
        for sid in ("services", "news", "streams", "releases", "requests"):
            self.assertEqual(rules.get(f'html[data-home-hide~="{sid}"] [data-arrive="{sid}"]', {}).get("display"),
                             "none", sid)
        for sid in ("services", "news"):
            self.assertEqual(rules.get(f'html[data-home-hide~="{sid}"] [data-home-pair]', {})
                             .get("grid-template-columns"), "minmax(0, 1fr)", sid)
        self.assertEqual(rules.get('html[data-home-hide~="services"][data-home-hide~="news"] [data-home-pair]', {})
                         .get("display"), "none")
        stack = rules.get("html[data-home-hide] [data-home-stack]", {})
        self.assertEqual((stack.get("display"), stack.get("flex-direction"), stack.get("row-gap")),
                         ("flex", "column", "2rem"))
        self.assertEqual(rules.get("html[data-home-hide] [data-home-stack] > :not([hidden])", {})
                         .get("margin-top"), "0")
        # Nothing touches the pair or the stack while every section is on.
        for sel in rules:
            if re.search(r"data-home-(pair|stack|hide)", sel):
                self.assertTrue(sel.startswith("html[data-home-hide"), sel)

    def test_index_carries_the_pair_and_stack_hooks(self):
        page = static_text("index.html")
        self.assertEqual(page.count("data-home-stack"), 1)
        self.assertEqual(page.count("data-home-pair"), 1)
        stack = re.search(r'<div class="([^"]*)" data-home-stack>', page)
        self.assertIsNotNone(stack)
        self.assertIn("space-y-8", stack.group(1).split())
        pair = page.index("data-home-pair>")
        services, news, streams = (page.index(f'data-arrive="{sid}"') for sid in ("services", "news", "streams"))
        self.assertTrue(stack.end() < pair < services < news < streams)
        # The pair closes before Active Streams: both sections sit inside it.
        between = page[pair:streams]
        self.assertEqual(between.count("<div") + 1, between.count("</div>"))

    def test_empty_site_name_shows_logo_only_and_page_titles(self):
        out = render(b=branding(**{"branding.app_name": ""}))
        self.assertIn("<title>Control Center</title>", out)
        self.assertNotIn('property="og:site_name"', out)
        body = out.split("<body>")[1]
        self.assertRegex(body, r'<h1 class="[^"]*\bhidden\b[^"]*"></h1>')
        self.assertNotIn(">WebServarr<", body)
        # The default name still renders normally.
        self.assertIn(">WebServarr</h1>", render().split("<body>")[1])

    def test_empty_site_name_leaves_no_stray_separator_anywhere(self):
        # Every place the name reaches: the tab title (with and without a page
        # suffix, and with no <title> at all), the preview tags, and the three
        # shell spots (sidebar, drawer, phone top bar).
        no_suffix = PAGE.replace("<title>WebServarr - Control Center</title>", "<title>WebServarr</title>")
        no_title = PAGE.replace("<title>WebServarr - Control Center</title>", "")
        for name in ("", "   "):
            for tagline in ("Movies for the family", ""):
                b = branding(**{"branding.app_name": name, "branding.tagline": tagline})
                for label, page, expected in (("suffix", PAGE, "Control Center"),
                                              ("no suffix", no_suffix, tagline),
                                              ("no title", no_title, tagline)):
                    with self.subTest(name=name, tagline=tagline, page=label):
                        out = render(b=b, page=page)
                        self.assertEqual(re.findall(r"<title>(.*?)</title>", out, re.S), [expected])
                        head = out.split("<body>")[0]
                        self.assertNotIn("og:site_name", head)
                        self.assertNotRegex(head, r'<meta [^>]*content="\s*"')   # no empty preview tag
                        for m in re.finditer(r'<meta [^>]*content="([^"]*)"', head):
                            self.assertNotRegex(m.group(1), r"^\s*[-|]|[-|]\s*$", m.group(0))
                        if tagline:
                            self.assertIn(f'property="og:title" content="{tagline}"', head)
                            self.assertIn(f'name="twitter:title" content="{tagline}"', head)
                        else:
                            self.assertNotIn("og:title", head)
                            self.assertNotIn("twitter:title", head)
                        body = out.split("<body>")[1]
                        self.assertEqual(len(re.findall(r'<h1 class="[^"]*\bhidden\b[^"]*"></h1>', body)), 2)
                        self.assertRegex(body, r'<span class="[^"]*\bhidden\b[^"]*"></span>')
                        self.assertNotIn("WebServarr", body)

    def test_only_a_missing_name_falls_back_to_the_default(self):
        b = {k: v for k, v in branding().items() if k != "app_name"}
        out = render(b=b)
        self.assertIn("<title>WebServarr - Control Center</title>", out)
        self.assertIn('property="og:site_name" content="WebServarr"', out)
        self.assertIn(">WebServarr</h1>", out.split("<body>")[1])
        self.assertEqual(pages._preview_meta({}, "", "")[0], "WebServarr")
        # A named site keeps its name everywhere, trimmed, with nothing hidden.
        out = render(b=branding(**{"branding.app_name": "  My Server  "}))
        self.assertIn("<title>My Server - Control Center</title>", out)
        self.assertIn(">My Server</h1>", out)
        self.assertNotRegex(out.split("<body>")[1], r'<h1 class="[^"]*\bhidden\b')

    def test_login_name_is_in_the_first_html(self):
        # R56: the name (or its absence) is served, not patched in by a script
        # after the first paint could already have shown the static default.
        page = static_text("login.html")
        named = branding(**{"branding.app_name": "My Server"})
        missing = {k: v for k, v in branding().items() if k != "app_name"}
        for label, b, text, hidden in (("empty", branding(**{"branding.app_name": ""}), "", True),
                                       ("spaces", branding(**{"branding.app_name": "   "}), "", True),
                                       ("markup", branding(**{"branding.app_name": "<b>x</b>"}),
                                        "&lt;b&gt;x&lt;/b&gt;", False),
                                       ("custom", named, "My Server", False),
                                       ("missing", missing, "WebServarr", False)):
            with self.subTest(label):
                out = render(user=None, name="login", b=b, page=page)
                found = re.findall(r'<h1 id="loginAppName" class="([^"]*)">([^<]*)</h1>', out)
                self.assertEqual(len(found), 1, found)
                cls, got = found[0]
                self.assertEqual(got, text)
                self.assertEqual("hidden" in cls.split(), hidden, cls)
                self.assertIn("text-frosted-blue", cls.split())
                self.assertNotIn("<b>x</b>", out.split("<body")[1])

    def test_login_script_leaves_the_name_alone_and_keeps_the_reveal(self):
        page = static_text("login.html")
        scripts = static_text("js", "login.js")   # the page's script, a file (script-src 'self')
        self.assertNotIn("loginAppName", scripts)
        flat = re.sub(r"\s+", " ", page)
        self.assertIn("#loginForm { visibility: hidden; }", flat)
        self.assertIn("#loginForm.auth-ready { visibility: visible; }", flat)
        flat_js = re.sub(r"\s+", " ", scripts)
        self.assertIn("if (f) f.classList.add('auth-ready');", flat_js)
        self.assertIn("setTimeout(revealForm, REVEAL_AFTER_MS);", flat_js)             # failsafe
        self.assertIn("revealForm();", flat_js)                                          # methods applied

    def test_phone_bar_shows_the_logo_when_there_is_no_name(self):
        def bar(out):
            return re.search(r'<div id="mobileTopBar".*?<div class="relative', out, re.S).group(0)
        logo = "/static/uploads/logo.png"
        out = bar(render(b=branding(**{"branding.app_name": "", "branding.logo_url": logo})))
        self.assertRegex(out, r'<a href="/" aria-label="Home" class="[^"]*"><img src="/static/uploads/logo\.png" '
                              r'alt="" class="[^"]*\bh-8\b[^"]*\bw-24\b[^"]*\bobject-contain\b[^"]*"></a>')
        # No logo, or one that isn't safe to serve: the logo icon, same as the sidebar.
        for value in ("", "javascript:alert(1)"):
            with self.subTest(logo=value):
                out = bar(render(b=branding(**{"branding.app_name": "", "branding.logo_url": value,
                                                "icon.sidebar_logo": "dns"})))
                self.assertNotIn("javascript:", out)
                self.assertNotIn("<img", out)
                self.assertRegex(out, r'<a href="/" aria-label="Home" class="[^"]*">.*>dns</span>', )
        # A named site keeps its name there and gets no second logo.
        out = bar(render(b=branding(**{"branding.app_name": "My Server", "branding.logo_url": logo})))
        self.assertIn(">My Server</span>", out)
        self.assertNotIn('aria-label="Home"', out)
        self.assertNotIn("<img", out)

    def test_theme_loader_leaves_a_blank_names_title_alone(self):
        # The server's title for a blank (or all-space) name is just the page
        # name; the client must not prefix it with the spaces and a " - ".
        code = js_code_only(static_text("js", "theme-loader.js"))
        self.assertRegex(code, r"var siteName = typeof data\.app_name === '[^']*' \? data\.app_name\.trim\(\) : '';\s*"
                               r"if \(siteName\) \{")
        self.assertRegex(code, r"document\.title = siteName \+ suffix;")
        self.assertNotRegex(code, r"document\.title = data\.app_name")

    def test_theme_loader_quotes_the_font_like_the_server(self):
        # A family with a word that starts with a digit ("Exo 2", "Source Sans
        # 3") is only a valid font-family when quoted. The loader's inline
        # value beats the server's #ws-theme rule, so it quotes the same way.
        src = static_text("js", "theme-loader.js")
        expr = r"""'"' \+ data\.font \+ '", sans-serif'"""
        self.assertEqual(len(live_matches(src, rf"setProperty\('--font-display', {expr}\)")), 1)
        # No other live write of the variable (a comment can't count either way).
        self.assertEqual(len(live_matches(src, r"setProperty\('--font-display',")), 1)
        # Parity with the server for the names that need the quotes.
        for family in ("Exo 2", "Source Sans 3", "Spline Sans"):
            with self.subTest(family=family):
                server = re.search(r"--font-display:([^;}]*)", pages.theme_style(branding(**{"theme.font": family})))
                self.assertIsNotNone(server)
                loader = '"' + family + '", sans-serif'     # what the pinned expression builds
                self.assertEqual(loader.replace(", ", ","), server.group(1))


class ShellFragment(unittest.TestCase):
    """GET /api/admin/settings/shell (Task 5 fix round 1, SH1): the parts of a
    page a soft navigation never replaces, rendered by the same code as the
    page itself, so Settings can show a saved change without a reload."""

    def test_the_fragment_is_what_the_page_renders(self):
        b = branding(**{"branding.app_name": "My Site", "branding.logo_url": "https://cdn.example.test/l.png",
                        "theme.custom_css": "a{color:red}", "theme.gauges_colourful": "true"})
        out = render(b=b, name="settings")
        frag = pages.shell_fragment(b, True, "settings", "WebServarr - Settings")
        self.assertEqual(set(frag), {"nav_html", "brand_html", "bar_brand_html", "theme_css", "font_href",
                                     "custom_css", "favicon", "title", "branding"})
        # Sidebar, drawer and phone bar carry exactly these fragments.
        self.assertEqual(out.count(frag["brand_html"]), 2)
        self.assertIn(frag["bar_brand_html"], out)
        self.assertEqual(len(re.findall(r"<div [^>]*\bdata-ws-brand>", out)), 2)
        self.assertEqual(len(re.findall(r'<span class="contents" data-ws-bar-brand>', out)), 1)
        self.assertIn(frag["nav_html"], out)
        self.assertIn('<style id="ws-theme">' + frag["theme_css"] + "</style>", out)
        self.assertIn('id="ws-font" rel="stylesheet" href="' + frag["font_href"].replace("&", "&amp;") + '"', out)
        self.assertEqual(frag["custom_css"], "a{color:red}")
        self.assertEqual(frag["favicon"], "https://cdn.example.test/l.png")
        # The title the page's own <title> would get (this fixture is Home).
        self.assertEqual(frag["title"], "My Site - Settings")
        self.assertIn("<title>" + pages.page_title(b, "WebServarr - Control Center") + "</title>", out)
        self.assertIn("My Site", frag["brand_html"])
        self.assertIn("--ws-gauge-cpu:var(--color-gauge-cpu)", frag["theme_css"])

    def test_no_name_no_logo(self):
        b = branding(**{"branding.app_name": "", "branding.logo_url": "", "branding.tagline": "Films"})
        frag = pages.shell_fragment(b, True, "settings", "WebServarr - Settings")
        self.assertEqual(frag["title"], "Settings")
        self.assertEqual(frag["favicon"], "/static/webservarr.svg")
        self.assertEqual(frag["custom_css"], "")
        self.assertIn('class="text-frosted-blue font-bold text-sm truncate max-w-[40%] hidden"', frag["bar_brand_html"])
        self.assertIn('aria-label="Home"', frag["bar_brand_html"])      # the bar's logo mark stands in
        self.assertEqual(pages.page_title(b, "WebServarr"), "Films")

    def test_the_endpoint_sends_it(self):
        src = open(os.path.join(os.path.dirname(pages.__file__), "routers", "admin_settings.py"), encoding="utf-8").read()
        self.assertIn('return shell_fragment(branding, True, "settings", "WebServarr - Settings")', src)
        page = open(os.path.join(pages.STATIC_DIR, "settings.html"), encoding="utf-8").read()
        self.assertIn("<title>WebServarr - Settings</title>", page)

    def test_fill_does_not_read_what_it_inserts(self):
        # An operator's text that looks like a slot stays text.
        self.assertEqual(pages.fill("{{{a}}}|{{b}}", {"a": "{{b}}", "b": "<x>"}), "{{b}}|&lt;x&gt;")
        b = branding(**{"branding.app_name": "{{user_name}}"})
        out = render(b=b)
        self.assertIn(">{{user_name}}</h1>", out)


class NavModel(unittest.TestCase):
    def nav_hrefs(self, out):
        nav = re.search(r'<nav id="desktopNav".*?</nav>', out, re.S).group(0)
        return re.findall(r'<a[^>]*href="([^"]+)"', nav)

    def test_nav_follows_pages_order(self):
        b = branding(**{"pages.order": '["home","wiki","calendar","requests","issues","tickets","library","settings"]'})
        self.assertEqual(self.nav_hrefs(render(b=b)),
                         ["/", "/wiki", "/calendar", "/requests", "/issues", "/tickets", "/settings"])

    def test_bad_order_is_normalised(self):
        b = branding(**{"pages.order": '["settings","wiki","home"]'})
        hrefs = self.nav_hrefs(render(b=b))
        self.assertEqual(hrefs[0], "/")
        self.assertEqual(hrefs[1], "/wiki")
        self.assertEqual(hrefs[-1], "/settings")

    def test_home_and_settings_cannot_be_switched_off(self):
        out = render(b=branding(**{"sidebar.enabled_home": "false"}))
        self.assertEqual(self.nav_hrefs(out)[0], "/")

    def test_books_needs_kavita_or_audiobooks(self):
        nav = lambda b: re.search(r'<nav id="desktopNav".*?</nav>', render(b=b), re.S).group(0)
        self.assertNotIn('>Books<', render())
        for name, values in (("kavita", {"integration.kavita.url": "http://192.168.1.50:5000"}),
                             ("audiobooks", {"integration.plex.audiobook_library": "7"})):
            with self.subTest(name):
                self.assertIn("Books", nav(branding(**values)))
                self.assertNotIn("Books", nav(branding(**dict(values, **{"sidebar.enabled_library": "false"}))))
        self.assertNotIn("Books", nav(branding(**{"integration.plex.audiobook_library": "  "})))

    def test_payload_carries_the_new_fields(self):
        b = branding()
        self.assertEqual(b["requests_source"], "native")
        self.assertEqual(b["pages_order"][0], "home")
        self.assertEqual(b["home_sections"], {"services": True, "news": True, "streams": True,
                                              "releases": True, "requests": True})
        self.assertNotIn("requests-embed", b["sidebar_labels"])
        self.assertNotIn("show_tickets", b["features"])
        self.assertNotIn("show_requests", b["features"])
        # "Kavita is set up" is its own name, not the retired features.show_books key.
        self.assertNotIn("show_books", b["features"])
        self.assertFalse(b["features"]["books_configured"])
        self.assertNotIn("ebooks_configured", b["features"])
        self.assertTrue(branding(**{"integration.kavita.url": "http://192.168.1.50:5000"})["features"]["books_configured"])
        self.assertTrue(branding(**{"integration.plex.audiobook_library": "7"})["features"]["books_configured"])
        self.assertEqual([i.get("feature") for i in NAV_ITEMS if i["id"] == "library"], ["books_configured"])
        b = branding(**{"requests.source": "seerr_embed", "home.section_news": "false"})
        self.assertEqual(b["requests_source"], "seerr_embed")
        self.assertFalse(b["home_sections"]["news"])
        self.assertEqual(branding(**{"requests.source": "iframe"})["requests_source"], "native")

    def test_nav_items_take_defaults_from_the_registry(self):
        from app.settings_registry import PAGE_DEFAULTS, SIDEBAR_PAGE_IDS
        self.assertEqual([i["id"] for i in NAV_ITEMS], list(SIDEBAR_PAGE_IDS))
        for item in NAV_ITEMS:
            self.assertEqual((item["label"], item["sublabel"], item["icon"]), PAGE_DEFAULTS[item["id"]])

    def test_nav_addresses_come_from_the_registry(self):
        # One map of page addresses (R14): the nav renders from it and the
        # Settings view serves it to the Pages tab.
        from app import settings_registry as reg
        self.assertIs(pages._NAV_HREF, reg.PAGE_ADDRESSES)
        self.assertEqual(list(reg.PAGE_ADDRESSES), list(reg.SIDEBAR_PAGE_IDS))
        for item in NAV_ITEMS:
            self.assertEqual(item["href"], reg.PAGE_ADDRESSES[item["id"]], item["id"])
        # Every page shown (Books needs Kavita or audiobooks), in a custom order: the
        # rendered links are the registry's addresses in that order.
        order = ["home", "library", "wiki", "tickets", "calendar", "issues", "requests", "settings"]
        b = branding(**{"integration.kavita.url": "http://192.168.1.50:5000", "pages.order": json.dumps(order)})
        self.assertEqual(self.nav_hrefs(render(b=b)), [reg.PAGE_ADDRESSES[p] for p in order])

    def test_migrated_seerr_embed_install_shows_one_requests_item(self):
        # An install that had the built-in Requests page off and the Seerr embed
        # on: the v1.11 migration sets requests.source to seerr_embed and turns
        # the Requests switch on. That state must render exactly one Requests
        # item, at /requests, carrying the pending-requests badge.
        from app import seed
        from app.routers.branding import load_branding
        from app.tests import helpers
        db = helpers.make_sessionmaker()()
        try:
            helpers.put(db, "requests.source", "native")
            helpers.put(db, "sidebar.enabled_requests", "false")
            helpers.put(db, "features.show_requests", "true")
            helpers.put(db, "sidebar.enabled_requests_embed", "true")
            helpers.put(db, "sidebar.label_requests_embed", "Seerr page")
            seed.migrate_requests_source_v1(db)
            b = load_branding(db, True)
        finally:
            db.close()
        self.assertEqual(b["requests_source"], "seerr_embed")
        out = render(b=b)
        for nav_id in ("desktopNav", "drawerNav"):
            with self.subTest(nav=nav_id):
                nav = re.search(r'<nav id="%s".*?</nav>' % nav_id, out, re.S).group(0)
                links = [ln for ln in nav.split("\n") if "<a " in ln]
                requests_links = [ln for ln in links if "/requests" in ln]
                self.assertEqual(len(requests_links), 1, requests_links)
                self.assertIn('href="/requests"', requests_links[0])
                self.assertIn('data-badge="requestsBadge"', requests_links[0])
                self.assertNotIn("Seerr page", nav)


class AssetStamping(unittest.TestCase):
    def test_stamp_uses_version_and_content_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "js"))
            with open(os.path.join(tmp, "js", "x.js"), "wb") as f:
                f.write(b"abc")
            with mock.patch.object(pages, "STATIC_DIR", tmp), mock.patch.object(pages.settings, "app_version", "1.0.0"):
                self.assertEqual(asset_stamp("/static/js/x.js"), "1.0.0-a9993e36")
                self.assertEqual(asset_stamp("/static/js/missing.js"), "1.0.0")
                out = pages._stamp_asset_versions('<script src="/static/js/x.js?v=3"></script><a href="/static/js/x.js">')
                self.assertIn('src="/static/js/x.js?v=1.0.0-a9993e36"', out)
                self.assertIn('href="/static/js/x.js">', out)   # no marker, no change

    def test_fill_escapes_by_default(self):
        self.assertEqual(pages.fill("<p>{{a}}{{{b}}}{{c}}</p>", {"a": "<x>", "b": "<i>raw</i>"}),
                         "<p>&lt;x&gt;<i>raw</i></p>")


class SoftNavServerSide(unittest.TestCase):
    """Soft navigation, server side (spec 4.1, 4.4): the page wrapper's module
    URL is cache-stamped like any script, a wrapped page's own head styles are
    tagged so the router can swap them, and every shell page carries the one
    persistent player slot and live region outside <main>."""

    WRAPPED = PAGE.replace("</head>", "<style>.x{}</style></head>").replace(
        "<p>hi</p>", '<div id="wsPage" data-ws-module="/static/js/pages/news.js?v=1"><p>hi</p></div>')

    def test_ws_module_attribute_is_stamped(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "js", "pages"))
            with open(os.path.join(tmp, "js", "pages", "news.js"), "wb") as f:
                f.write(b"export async function mount(ctx) {}\n")
            # No shell markers: the partials are not in the temporary tree.
            page = self.WRAPPED.replace("<!-- ws:sidebar -->", "").replace("<!-- ws:header -->", "")
            with mock.patch.object(pages, "STATIC_DIR", tmp), mock.patch.object(pages.settings, "app_version", "1.0.0"):
                out = render(page=page, name="news")
                stamp = asset_stamp("/static/js/pages/news.js")
        self.assertRegex(stamp, r"^1\.0\.0-[0-9a-f]{8}$")
        self.assertIn(f'data-ws-module="/static/js/pages/news.js?v={stamp}"', out)
        self.assertNotIn('news.js?v=1"', out)

    def test_page_styles_are_tagged_only_on_wrapped_pages(self):
        b = branding(**{"theme.custom_css": "body{}"})
        out = render(page=self.WRAPPED, b=b, name="news")
        self.assertIn("<style data-ws-page-style>.x{}</style>", out)
        self.assertEqual(out.count("data-ws-page-style"), 1)
        # The shared styles the server adds are never the page's to swap.
        self.assertRegex(out, r'<style id="ws-theme">')
        self.assertIn('<style id="webservarr-custom-css">', out)
        # Only <head> styles: one in the body stays as written.
        body_style = self.WRAPPED.replace("<p>hi</p>", "<style>.y{}</style><p>hi</p>")
        self.assertIn("<style>.y{}</style>", render(page=body_style, name="news"))
        # A page with no #wsPage is not converted and is left alone.
        plain = PAGE.replace("</head>", "<style>.x{}</style></head>")
        self.assertNotIn("data-ws-page-style", render(page=plain, b=b))

    def test_player_slot_and_live_region_once(self):
        from app.tests.test_shell_contract import SHELL_PAGES, read
        for name in SHELL_PAGES:
            with self.subTest(name):
                out = render(page=read(name), name=name)
                self.assertEqual(out.count('id="wsPlayer"'), 1)
                self.assertEqual(out.count('id="wsLive"'), 1)
                self.assertIn('<div id="wsPlayer" hidden></div>', out)
                self.assertIn('<div id="wsLive" class="sr-only" aria-live="polite"></div>', out)
                end_main = out.rindex("</main>")
                self.assertGreater(out.index('id="wsPlayer"'), end_main)
                self.assertGreater(out.index('id="wsLive"'), end_main)
                # The soft navigation's progress bar (router.js): hidden at
                # rest, outside <main>, never read out (<main> is aria-busy).
                self.assertEqual(out.count('id="wsProgress"'), 1)
                self.assertIn('<div id="wsProgress" hidden aria-hidden="true"></div>', out)
                self.assertGreater(out.index('id="wsProgress"'), end_main)
        # Pages without the shell (login, setup) get none of them.
        bare = render(page=PAGE.replace("<!-- ws:sidebar -->", "").replace("<!-- ws:header -->", ""))
        self.assertNotIn("wsPlayer", bare)
        self.assertNotIn("wsLive", bare)
        self.assertNotIn("wsProgress", bare)

    def test_ui_js_once_on_every_shell_page_before_its_scripts(self):
        # The toast and dialog come with the shell: once, ahead of router.js
        # and of every script the page itself carries.
        from app.tests.test_shell_contract import SHELL_PAGES, read
        for name in SHELL_PAGES:
            with self.subTest(name):
                out = render(page=read(name), name=name)
                self.assertEqual(len(re.findall(r'<script src="/static/js/ui\.js\?v=[^"]+"></script>', out)), 1)
                at = out.index("/static/js/ui.js?v=")
                self.assertLess(at, out.index("/static/js/router.js?v="))
                self.assertLess(at, out.index("/static/js/auth.js?v="))


if __name__ == "__main__":
    unittest.main()


class SettingsSetupFlags(unittest.TestCase):
    """Polish A fix round 1: the Settings skeleton takes the tab's shape from
    which connections are set up, served in the data block of that page only."""

    def test_the_flags_ride_in_the_data_block_only_when_given(self):
        setup = {"plex": False, "seerr": True}
        self.assertEqual(data_of(render(name="settings", flags={"setup": setup}))["setup"], setup)
        self.assertNotIn("setup", data_of(render(name="index")))

    def test_flags_are_truthiness_of_the_saved_values(self):
        class Row:
            def __init__(self, key, value):
                self.key, self.value = key, value
        rows = [Row("integration.plex.url", "http://plex:32400"), Row("integration.plex.token", ""),
                Row("integration.seerr.url", "http://seerr"), Row("integration.authentik.client_secret", "s")]
        session = mock.MagicMock()
        session.query.return_value.filter.return_value.all.return_value = rows
        from app.services import push
        with mock.patch.object(pages, "SessionLocal", return_value=session), \
             mock.patch.object(push, "status_reason", return_value=None):
            got = pages.settings_setup()
        self.assertEqual(got, {"plex": False, "seerr": True, "chaptarr": False, "sonarr": False, "radarr": False,
                               "kavita": False, "audiobooks": False, "authentik_url": False, "authentik_secret": True,
                               "push_reason": None})
        session.close.assert_called_once()


class NewsCardsHoldTheirSkeleton(unittest.TestCase):
    """Polish A fix round 1: a short post keeps two lines of excerpt (and two
    title lines on a phone), so it is the height of its skeleton card on the
    home page and the archive."""

    def test_renderers_and_skeletons_agree(self):
        titles = {"index.html": "'<h4 data-news-title class=\"font-bold text-frosted-blue break-words min-w-0' + "
                                "(open ? '' : ' min-h-12 sm:min-h-0') + '\">'",
                  "news.html": "'<h2 data-news-title class=\"font-bold text-frosted-blue break-words min-w-0 min-h-12 sm:min-h-0\">'"}
        for name, tag, cards in (("index.html", "h4", 2), ("news.html", "h2", 3)):
            with self.subTest(name):
                page = static_text(name)
                # Each renders its cards in its page module (soft navigation).
                cards_js = static_text("js", "pages", "news.js" if name == "news.html" else "home.js")
                self.assertIn(titles[name], cards_js)
                # Fix round 2: an open card (pinned, new, or after Read more) has no title gap.
                self.assertIn("if (title) title.classList.toggle('min-h-12', !nowOpen);", cards_js)
                self.assertIn("'<p class=\"text-sm text-frosted-blue/70 mt-1 line-clamp-2 min-h-10\">'", cards_js)
                self.assertEqual(page.count('<p class="font-bold min-h-12 sm:min-h-0">&nbsp;</p>'), cards)
                self.assertEqual(page.count('<p class="text-sm mt-1 min-h-10">&nbsp;</p>'), cards)
                self.assertNotIn("<br", page[page.index('<div class="skel rounded-xl p-4'):page.index('<div class="skel rounded-xl p-4') + 600])


class FunctionText(unittest.TestCase):
    """function_text (StreamsPreview.body_of) returns the whole function, even
    when comments come before the text a test looks for (Task 10 fix TH1)."""

    SRC = ("function before() { return 1; }\n"
           "// a comment { with a brace } before the function\n"
           "function target(a) {\n"
           "    // a comment, several words long, before the text asserted below\n"
           "    /* and a block comment { } too */\n"
           "    var s = '}';   // a brace in a string\n"
           "    return a + 1;   // THE-END\n"
           "}\n"
           "function after() { return 2; }\n")

    def test_the_whole_function_comments_included(self):
        got = function_text(self.SRC, "function target(a)")
        self.assertTrue(got.startswith("function target(a) {"), got)
        self.assertTrue(got.endswith("return a + 1;   // THE-END\n}"), got)
        self.assertNotIn("function after", got)

    def test_home_renderers_are_whole(self):
        page = static_text("js", "pages", "home.js")
        body = function_text(page, "function renderActiveStreams(streams)")
        # After several comments in the function: cut short, these were lost.
        self.assertIn("return renderStreamCard(stream, _streamsPreview);", body)
        self.assertTrue(body.rstrip().endswith("});\n    }"), body[-80:])


class StreamsPreview(unittest.TestCase):
    """Owner request: /?preview=streams shows admins three sample streams on
    Home, through the same renderer as real ones, and nobody else anything."""

    def setUp(self):
        self.page = static_text("js", "pages", "home.js")   # Home's page module
        self.code = js_code_only(self.page)

    def body_of(self, signature):
        return function_text(self.page, signature)

    def test_the_flag_needs_the_url_the_session_admin_and_the_server_mark(self):
        gate = ("_streamsPreview = ctx.url.searchParams.get('preview') === 'streams' &&\n"
                "        user.is_admin === true && document.documentElement.hasAttribute('data-admin');")
        self.assertEqual(self.page.count(gate), 1)
        self.assertEqual(len(live_matches(self.page, r"_streamsPreview = ")), 2)   # the false default and the gate
        self.assertEqual(len(live_matches(self.page, r"var _streamsPreview = false;")), 1)
        # Set after the user is known, so a member's session never turns it on.
        self.assertLess(self.page.index("const user = await checkAuth();"), self.page.index(gate))

    def test_the_server_marks_only_admins(self):
        self.assertIn(" data-admin", html_tag(render(user=ADMIN)))
        self.assertNotIn("data-admin", html_tag(render(user=MEMBER)))
        self.assertNotIn("data-admin", html_tag(render(user=None)))

    def test_samples_go_through_the_real_renderer_and_the_poll_never_fetches(self):
        loader = self.body_of("async function loadActiveStreams()")
        self.assertTrue(loader.split("\n")[1].strip().startswith(
            "if (_streamsPreview) { renderActiveStreams(sampleSet()); return; }"), loader)
        self.assertLess(loader.index("_streamsPreview"), loader.index("/api/integrations/active-streams"))
        # The sample label only shows while the preview is on, laid over the artwork.
        self.assertIn("${preview ? '<span class=\"absolute top-3 left-3 ", self.page)
        self.assertEqual(len(live_matches(self.page, r"return renderStreamCard\(stream, _streamsPreview\);")), 1)

    def test_three_samples_direct_play_transcode_and_no_artwork(self):
        samples = self.body_of("function sampleStreams()")
        self.assertEqual(samples.count("session_id: 'sample-"), 3)
        self.assertEqual(re.findall(r"decision: '([^']+)'", samples), ["Direct Play", "Transcode", "Direct Stream"])
        self.assertEqual(re.findall(r"progress: (\d+)", samples), ["35", "70", "5"])
        self.assertIn("thumb_url: ''", samples)
        self.assertEqual(re.findall(r"title: '([^']+)'", samples),
                         ["Sample Movie", "Sample Show", "Sample Movie Without Artwork"])

    def test_sample_data_holds_no_instance_strings_or_real_urls(self):
        block = self.page[self.page.index("// Sample artwork:"):self.page.index("// A Direct Play card with nothing in it:")]
        self.assertIn("function sampleStreams()", block)
        self.assertNotIn("https:", block)
        self.assertNotIn("/api/", block)
        self.assertNotIn("/library/", block)          # no Plex artwork path
        self.assertIn("'data:image/svg+xml,'", block)
        for i, bad in enumerate(FORBIDDEN_STRINGS):
            self.assertNotIn(bad.lower(), block.lower(), f"instance-specific string #{i}")

    def test_card_words_use_the_pure_status_colours(self):
        card = self.body_of("function renderStreamCard(stream, preview)")
        for cls in ('text-status-ok text-xs font-bold', 'text-status-warn text-[11px] font-bold',
                    'text-status-warn/70 hover:text-status-warn', 'text-status-warn/80'):
            self.assertIn(cls, card)
        self.assertNotIn("status-ok-text", card)
        self.assertNotIn("status-warn-text", card)

