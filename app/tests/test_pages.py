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
        self.assertIn('href="/settings"', render(user=ADMIN))
        self.assertNotIn('href="/settings"', render(user=MEMBER))
        self.assertIn("data-admin", html_tag(render(user=ADMIN)))
        self.assertNotIn("data-admin", html_tag(render(user=MEMBER)))
        # Version label and the account-settings menu entry hide for members.
        self.assertIn('id="appVersion" class="text-steel-blue text-[10px] text-center ">v9.9.9', render(user=ADMIN))
        self.assertIn('id="appVersion" class="text-steel-blue text-[10px] text-center hidden">v9.9.9', render(user=MEMBER))

    def test_feature_gated_and_disabled_items(self):
        b = branding(**{"features.show_tickets": "false", "sidebar.enabled_calendar": "false"})
        out = render(b=b)
        self.assertNotIn('href="/tickets"', out)
        self.assertNotIn('href="/calendar"', out)
        self.assertIn('href="/issues"', out)
        # Feature-gated items appear when their flag is on.
        self.assertNotIn('href="/requests-embed"', render())
        self.assertIn('href="/requests-embed"', render(b=branding(**{"features.show_requests": "true"})))
        self.assertIn('id="requestsBadge"', render(b=branding(**{"features.show_requests": "true"})))

    def test_labels_icons_sublabels_and_new_flag_apply(self):
        b = branding(**{"sidebar.label_issues": "Problems", "icon.nav_issues": "bug_report",
                        "sidebar.sublabel_issues": "", "sidebar.new_issues": "true"})
        out = render(b=b)
        self.assertIn("Problems", out)
        self.assertIn(">bug_report<", out)
        self.assertIn('class="nav-new-badge"', out)
        # Empty sublabel means "no second line" for that item.
        self.assertRegex(out, r'href="/issues"[^\n]*<span>Problems<span class="nav-new-badge">New!</span></span>')

    def test_user_strings_are_escaped_and_bad_avatar_dropped(self):
        out = render(user=MEMBER)
        self.assertIn("Sam &lt;b&gt;", out)
        self.assertNotIn("Sam <b>", out)
        self.assertIn("background-image:url('/static/a.png')", render(user=ADMIN))
        self.assertEqual(pages.public_user({"avatar_url": "javascript:alert(1)"})["avatar_url"], "")
        self.assertEqual(pages.public_user({"avatar_url": "//evil/x.png"})["avatar_url"], "")
        self.assertEqual(pages.public_user({"avatar_url": "https://plex.tv/u.png"})["avatar_url"], "https://plex.tv/u.png")

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
        self.assertNotIn("@import", out.split("<body>")[0].replace(
            re.search(r'<script id="ws-data".*?</script>', out, re.S).group(0), ""))

    def test_ws_data_precedes_theme_loader(self):
        out = render()
        self.assertLess(out.index('id="ws-data"'), out.index("theme-loader.js"))

    def test_title_rewrite_and_og_kept(self):
        out = render(b=branding(**{"branding.app_name": "My Server"}))
        self.assertIn("<title>My Server - Control Center</title>", out)
        self.assertIn('property="og:site_name" content="My Server"', out)
        self.assertIn('property="og:url" content="https://example.test/"', out)

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


if __name__ == "__main__":
    unittest.main()
