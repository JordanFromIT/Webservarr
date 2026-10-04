"""
Phone navigation (docs/superpowers/specs/2026-10-04-mobile-nav-and-home-screen-design.md,
Part 1): the bottom tab bar, the More sheet and the phone top bar, rendered by
app/pages.py for the signed-in user from the operator's nav settings.

Below lg the first four pages the user can see become tabs, in the operator's
order, and the last tab is always More: the More sheet holds the remaining
pages, then "Add to home screen", Account settings (admins) and Sign out. With
four pages or fewer every page is a tab; More stays, because Sign out and
"Add to home screen" live there (the spec's "no More tab" case would leave a
phone with no way to sign out).
"""
import os
import re
import unittest

from app import pages
from app.tests.test_pages import ADMIN, MEMBER, PAGE, branding, render


def setUpModule():
    pages.STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")


def tab_bar(out):
    m = re.search(r'<nav id="wsTabBar"[^>]*>(.*?)</nav>', out, re.S)
    assert m, "no #wsTabBar"
    return m.group(1)


def tabs(out):
    """[(href or 'more', label, current)] in order."""
    found = []
    for m in re.finditer(r'<(a|button)\b([^>]*)>(.*?)</\1>', tab_bar(out), re.S):
        attrs, inner = m.group(2), m.group(3)
        label = re.search(r'<span class="ws-navtab-label">([^<]*)</span>', inner).group(1)
        href = re.search(r'href="([^"]*)"', attrs)
        cur = re.search(r'aria-current="([^"]*)"', attrs)
        found.append((href.group(1) if href else "more", label, cur.group(1) if cur else None))
    return found


def sheet(out):
    m = re.search(r'<dialog id="wsMoreSheet"[^>]*>(.*?)</dialog>', out, re.S)
    assert m, "no #wsMoreSheet"
    return m.group(1)


def more_rows(out):
    m = re.search(r'<ul id="wsMoreNav"[^>]*>(.*?)</ul>', sheet(out), re.S)
    return [(h, re.sub(r"<[^>]+>", "", l).strip(), c)
            for h, c, l in re.findall(r'<a class="ws-sheet-row" href="([^"]*)"((?: aria-current="page")?)>.*?'
                                       r'<span class="ws-sheet-row-label">(.*?)</span>', m.group(1), re.S)]


ALL_ON = {"integration.kavita.url": "http://192.168.1.50:5000"}


class TabBar(unittest.TestCase):
    def test_first_four_pages_in_order_then_more(self):
        out = render(user=ADMIN, b=branding(**ALL_ON))
        self.assertEqual(tabs(out), [("/", "Home", "page"), ("/requests", "Requests", None),
                                     ("/issues", "Issues", None), ("/calendar", "Calendar", None),
                                     ("more", "More", None)])
        self.assertEqual([r[0] for r in more_rows(out)], ["/tickets", "/books", "/wiki", "/settings"])

    def test_members_get_their_own_set(self):
        out = render(user=MEMBER, b=branding(**ALL_ON))
        self.assertEqual([t[0] for t in tabs(out)], ["/", "/requests", "/issues", "/calendar", "more"])
        self.assertEqual([r[0] for r in more_rows(out)], ["/tickets", "/books", "/wiki"])
        self.assertNotIn('href="/settings"', tab_bar(out) + sheet(out))

    def test_the_operators_order_switches_and_labels_decide(self):
        b = branding(**dict(ALL_ON, **{
            "pages.order": '["home","wiki","tickets","library","requests","issues","calendar","settings"]',
            "sidebar.enabled_tickets": "false",
            "sidebar.label_wiki": "Guides & help",
            "icon.nav_wiki": "help",
        }))
        out = render(user=MEMBER, b=b)
        self.assertEqual(tabs(out), [("/", "Home", "page"), ("/wiki", "Guides &amp; help", None),
                                     ("/books", "Books", None), ("/requests", "Requests", None),
                                     ("more", "More", None)])
        self.assertIn(">help</span>", tab_bar(out))
        self.assertEqual([r[0] for r in more_rows(out)], ["/issues", "/calendar"])

    def test_four_pages_or_fewer_are_all_tabs_and_more_stays(self):
        b = branding(**{"sidebar.enabled_issues": "false", "sidebar.enabled_calendar": "false",
                        "sidebar.enabled_tickets": "false"})
        out = render(user=MEMBER, b=b)
        self.assertEqual([t[0] for t in tabs(out)], ["/", "/requests", "/wiki", "more"])
        self.assertEqual(more_rows(out), [])
        # Sign out is still one tap into More.
        self.assertIn("data-logout", sheet(out))

    def test_active_tab_and_more_follow_the_page(self):
        out = render(user=ADMIN, name="issues", b=branding(**ALL_ON))
        self.assertEqual([t[2] for t in tabs(out)], [None, None, "page", None, None])
        # A page that lives in More: More is the active tab, its row is current.
        out = render(user=ADMIN, name="wiki", b=branding(**ALL_ON))
        self.assertEqual(tabs(out)[-1], ("more", "More", "true"))
        self.assertEqual([r for r in more_rows(out) if r[2]], [("/wiki", "Wiki", ' aria-current="page"')])
        # Sub-pages highlight their section (a book is Books).
        out = render(user=ADMIN, name="book", b=branding(**ALL_ON))
        self.assertEqual(tabs(out)[-1][2], "true")
        self.assertEqual([r[0] for r in more_rows(out) if r[2]], ["/books"])

    def test_more_is_a_button_that_opens_the_sheet(self):
        out = render(b=branding(**ALL_ON))
        m = re.search(r'<button\b([^>]*)>(?:(?!</button>).)*<span class="ws-navtab-label">More</span>', tab_bar(out), re.S)
        self.assertIsNotNone(m)
        attrs = m.group(1)
        for want in ('type="button"', 'id="wsMoreBtn"', 'aria-haspopup="dialog"', 'aria-expanded="false"',
                     'aria-controls="wsMoreSheet"'):
            self.assertIn(want, attrs)

    def test_requests_keeps_its_pending_badge(self):
        out = render(b=branding(**ALL_ON))
        self.assertRegex(tab_bar(out), r'href="/requests".*?data-badge="requestsBadge"')
        # In More, when the operator moved it there.
        b = branding(**dict(ALL_ON, **{
            "pages.order": '["home","wiki","tickets","library","requests","issues","calendar","settings"]'}))
        self.assertRegex(sheet(render(b=b)), r'href="/requests".*?data-badge="requestsBadge"')

    def test_tabs_and_rows_escape_operator_text(self):
        b = branding(**{"sidebar.label_requests": "<b>Ask</b>", "sidebar.sublabel_tickets": "<i>x</i>",
                        "icon.nav_issues": "bug_report"})
        out = render(b=b)
        self.assertIn("&lt;b&gt;Ask&lt;/b&gt;", tab_bar(out))
        self.assertNotIn("<b>Ask</b>", out)
        self.assertIn("&lt;i&gt;x&lt;/i&gt;", sheet(out))

    def test_rows_carry_icon_label_sublabel_and_new_flag(self):
        b = branding(**dict(ALL_ON, **{"sidebar.new_wiki": "true", "sidebar.sublabel_tickets": ""}))
        s = sheet(render(b=b))
        self.assertRegex(s, r'href="/wiki"[^>]*>\s*<span class="material-symbols-outlined ws-sheet-row-icon"'
                            r'[^>]*>library_books</span>')
        self.assertRegex(s, r'href="/wiki".*?Read guides and how-tos')
        self.assertRegex(s, r'href="/wiki".*?class="nav-new-badge">New!</span>')
        # An empty sublabel hides the line.
        row = re.search(r'href="/tickets".*?</a>', s, re.S).group(0)
        self.assertNotIn("ws-sheet-row-sub", row)


class MoreSheet(unittest.TestCase):
    def test_rows_in_the_specified_order(self):
        s = sheet(render(user=ADMIN, b=branding(**ALL_ON)))
        order = [s.index('id="wsMoreNav"'), s.index("data-install-row"), s.index('href="/settings#sign-in"'),
                 s.index("data-logout")]
        self.assertEqual(order, sorted(order))

    def test_account_settings_is_for_admins_only(self):
        def account_li(out):
            return re.search(r'<li class="([^"]*)">\s*<a class="ws-sheet-row" href="/settings#sign-in"', sheet(out)).group(1)
        self.assertNotIn("hidden", account_li(render(user=ADMIN)).split())
        self.assertIn("hidden", account_li(render(user=MEMBER)).split())

    def test_sign_out_names_who_is_signed_in(self):
        s = sheet(render(user=MEMBER))
        self.assertRegex(s, r'(?s)data-logout[^>]*>.*?Sign out.*?Signed in as Sam &lt;b&gt;')

    def test_is_a_labelled_dialog_with_a_close_button(self):
        out = render()
        self.assertRegex(out, r'<dialog id="wsMoreSheet" class="ws-sheet" aria-labelledby="wsMoreTitle">')
        self.assertRegex(sheet(out), r'<h2 id="wsMoreTitle"[^>]*>More</h2>')
        self.assertRegex(sheet(out), r'<button type="button" class="ws-sheet-close" data-sheet-close aria-label="Close">')

    def test_install_row_names_the_site(self):
        s = sheet(render(b=branding(**{"branding.app_name": "My <Site>"})))
        self.assertIn("Open My &lt;Site&gt; like an app", s)
        s = sheet(render(b=branding(**{"branding.app_name": ""})))
        self.assertIn("Open this site like an app", s)
        # Hidden until install.js has decided (an installed app never shows it).
        self.assertRegex(s, r"<li data-install-row hidden>")


class TopBar(unittest.TestCase):
    def bar(self, out):
        return re.search(r'<div id="mobileTopBar".*?</div>\s*</div>\s*</div>', out, re.S).group(0)

    def test_page_label_and_bell_only(self):
        out = render(user=ADMIN, name="issues", b=branding(**{"sidebar.label_issues": "Problems & fixes"}))
        bar = self.bar(out)
        self.assertRegex(bar, r'<p id="wsBarTitle"[^>]*>Problems &amp; fixes</p>')
        self.assertIn('title="Notifications"', bar)
        for gone in ("hamburgerBtn", "mobileUserMenuBtn", "Account menu", "Open menu", "<img", "data-ws-bar-brand"):
            self.assertNotIn(gone, bar)

    def test_sub_pages_show_their_section_and_unknown_pages_their_title(self):
        self.assertIn(">Books</p>", self.bar(render(name="book", b=branding(**ALL_ON))))
        self.assertIn(">Home</p>", self.bar(render(name="news")))
        page = PAGE.replace("WebServarr - Control Center", "WebServarr - Player test")
        self.assertIn(">Player test</p>", self.bar(render(name="player-test", page=page)))

    def test_no_menu_or_drawer_anywhere(self):
        out = render(b=branding(**ALL_ON))
        for gone in ('id="hamburgerBtn"', 'id="drawerOverlay"', 'id="drawerPanel"', 'id="drawerNav"',
                     'id="drawerCloseBtn"', 'id="mobileUserMenuBtn"', 'id="mobileUserMenuDropdown"',
                     'id="mobileUsername"', 'id="mobileRole"'):
            self.assertNotIn(gone, out)


class FragmentAndIds(unittest.TestCase):
    def test_fragment_carries_the_phone_nav(self):
        b = branding(**dict(ALL_ON, **{"sidebar.label_settings": "Admin"}))
        out = render(user=ADMIN, name="settings", b=b)
        frag = pages.shell_fragment(b, True, "settings", "WebServarr - Settings")
        self.assertNotIn("bar_brand_html", frag)
        self.assertIn(frag["tabs_html"], out)
        self.assertIn(frag["more_html"], out)
        self.assertEqual(frag["bar_title"], "Admin")
        self.assertIn('id="wsMoreBtn"', frag["tabs_html"])
        self.assertIn('href="/settings" aria-current="page"', frag["more_html"])

    def test_no_duplicate_ids_with_every_page_in_more(self):
        b = branding(**dict(ALL_ON, **{"sidebar.new_" + p: "true" for p in pages.SIDEBAR_PAGE_IDS}))
        out = render(user=ADMIN, b=b, flags={"page_off": True})
        ids = re.findall(r'''\sid=["']([^"']+)["']''', out)
        self.assertEqual(sorted({i for i in ids if ids.count(i) > 1}), [])


class SafeAreas(unittest.TestCase):
    def test_shell_pages_reach_the_safe_areas(self):
        # env(safe-area-inset-*) is 0 unless the page covers the whole screen,
        # and the tab bar pads for the home indicator with it.
        from app.tests.test_shell_contract import SHELL_PAGES, read
        for n in SHELL_PAGES:
            with self.subTest(n):
                out = render(name=n, page=read(n))
                metas = re.findall(r'<meta\b[^>]*name="viewport"[^>]*>', out)
                self.assertEqual(len(metas), 1, metas)
                self.assertIn("viewport-fit=cover", metas[0])
                self.assertEqual(metas[0].count("viewport-fit"), 1)
        # Pages without the shell are left as they are.
        out = render(name="login", page=PAGE.replace("<!-- ws:sidebar -->", "").replace("<!-- ws:header -->", "")
                     .replace("<head>", '<head><meta content="width=device-width, initial-scale=1.0" name="viewport"/>'))
        self.assertNotIn("viewport-fit", out)


class HeadLinks(unittest.TestCase):
    def test_every_page_links_the_manifest_icon_and_theme_colour(self):
        b = branding(**{"theme.color_background": "#101820"})
        for name, user in (("index", ADMIN), ("issues", MEMBER), ("login", None), ("settings", ADMIN)):
            with self.subTest(name):
                head = render(user=user, name=name, b=b).split("</head>")[0]
                self.assertIn('<link rel="manifest" href="/manifest.webmanifest">', head)
                self.assertIn('<link rel="apple-touch-icon" href="/static/webservarr-app-192.png">', head)
                self.assertIn('<meta name="theme-color" content="#101820">', head)

    def test_a_custom_icon_is_the_touch_icon(self):
        head = render(b=branding(**{"branding.app_icon_url": "/static/uploads/logo-1a2b.png"})).split("</head>")[0]
        self.assertIn('<link rel="apple-touch-icon" href="/static/uploads/logo-1a2b.png">', head)
        for bad in ("//evil.example/i.png", "javascript:alert(1)", ""):
            with self.subTest(bad=bad):
                head = render(b=branding(**{"branding.app_icon_url": bad})).split("</head>")[0]
                self.assertIn('<link rel="apple-touch-icon" href="/static/webservarr-app-192.png">', head)

    def test_the_app_name_marker_is_filled(self):
        page = PAGE.replace("<p>hi</p>", "<h2>Add <!-- ws:app-name --> to your home screen</h2>")
        out = render(page=page, b=branding(**{"branding.app_name": "A & B"}))
        self.assertIn("<h2>Add A &amp; B to your home screen</h2>", out)
        out = render(page=page, b=branding(**{"branding.app_name": " "}))
        self.assertIn("<h2>Add this site to your home screen</h2>", out)

    def test_the_app_icon_image_is_filled(self):
        page = PAGE.replace("<p>hi</p>", '<img data-ws-app-icon src="/static/webservarr-app-192.png" alt="">')
        out = render(page=page, b=branding(**{"branding.app_icon_url": "https://cdn.example.test/i.png"}))
        self.assertIn('<img data-ws-app-icon src="https://cdn.example.test/i.png" alt="">', out)


if __name__ == "__main__":
    unittest.main()
