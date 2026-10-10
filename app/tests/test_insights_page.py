"""
The Insights page (docs/superpowers/specs/2026-10-10-insights-design.md,
section 7): served to the admin only, on every way in, as Settings is; its
link is the admin's alone, just above Settings; its module reads everything
through one readLive on the page's signal, times everything with the visit,
writes text only and has no blue primary button.
"""
import re
import unittest

try:
    from app.tests.test_settings_gate import SettingsGateBase
    from app.tests.test_shell_contract import js_code_only
    from app.tests.test_soft_nav import module_source
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False
    SettingsGateBase = unittest.TestCase


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class InsightsPage(SettingsGateBase):
    def test_only_the_admin_gets_the_page(self):
        for headers in ({}, {"X-WS-Nav": "1"}):
            c = self.callers()
            with self.subTest(soft_nav=bool(headers)):
                r = c["signed out"].get("/insights", headers=headers)
                self.assertEqual((r.status_code, r.headers.get("location")), (302, "/login"))
                r = c["member"].get("/insights", headers=headers)
                self.assertEqual((r.status_code, r.headers.get("location")), (302, "/"))
                r = c["admin"].get("/insights", headers=headers)
                self.assertEqual(r.status_code, 200)
                self.assertIn('data-page="insights"', r.text)
                self.assertIn('id="ws-data"', r.text)

    def test_the_raw_page_file_is_never_served(self):
        for name, c in self.callers().items():
            with self.subTest(caller=name):
                self.assertEqual(c.get("/static/insights.html").status_code, 404)

    def test_the_link_is_the_admins_alone(self):
        for name, c in self.callers().items():
            if name == "signed out":
                continue
            with self.subTest(caller=name):
                page = c.get("/books" if name == "member" else "/insights").text
                self.assertEqual('href="/insights"' in page, name == "admin")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Nav(unittest.TestCase):
    def test_just_above_settings_for_an_admin_and_never_for_a_member(self):
        from app import pages
        from app.tests.test_pages import branding
        admin = [i["id"] for i in pages.visible_nav_items(branding(), True)]
        self.assertEqual(admin[-2:], ["insights", "settings"])
        self.assertNotIn("insights", [i["id"] for i in pages.visible_nav_items(branding(), False)])
        link = next(i for i in pages.visible_nav_items(branding(), True) if i["id"] == "insights")
        self.assertEqual((link["href"], link["label"], link["sublabel"], link["icon"], link["new"]),
                         ("/insights", "Insights", "See reading and listening", "insights", False))
        self.assertEqual(pages.bar_title(branding(), "insights"), "Insights")
        self.assertEqual(pages.PAGE_NAV["insights"], "insights")

    def test_settings_pages_are_unchanged(self):
        from app import settings_registry as reg
        self.assertNotIn("insights", reg.SIDEBAR_PAGE_IDS)
        self.assertNotIn("sidebar.label_insights", reg.REGISTRY)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Module(unittest.TestCase):
    def code(self, keep_strings=False):
        return js_code_only(module_source("insights"), keep_strings=keep_strings)

    def test_one_read_path_on_the_pages_signal(self):
        code = self.code()
        self.assertNotRegex(code, r"(?<![.\w])fetch\(")
        self.assertEqual(re.findall(r"\bgetJSON\([^)]*\)", code), ["getJSON(url, { signal: signal })"])
        self.assertRegex(code, r"function readLive\(url\) \{\s*return WS\.getJSON\(url, \{ signal: signal \}\);")

    def test_timers_are_the_visits(self):
        code = self.code()
        self.assertNotRegex(code, r"(?<![.\w])setTimeout\(|\bsetInterval\(|\bWS\.poll\(")
        self.assertIn("ctx.poll(", code)

    def test_text_only_and_inside_the_page(self):
        code = self.code()
        self.assertNotRegex(code, r"innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|document\.write")
        self.assertNotRegex(code, r"\bdocument\.getElementById\(")

    def test_no_blue_primary_button(self):
        self.assertNotIn("bg-primary", self.code(keep_strings=True))


if __name__ == "__main__":
    unittest.main()
