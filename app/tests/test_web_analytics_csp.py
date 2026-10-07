"""
Cloudflare Web Analytics and the CSP (app/web_analytics.py).

Off, the shipped default, every response keeps the strict CSP byte for byte.
On, HTML responses (shell pages, the login page, static HTML) also allow the
beacon's script host, and nothing else changes: the injected beacon reports to
the site's own /cdn-cgi/rum, which connect-src 'self' already covers.
The switch is cached in Redis, which both workers share, and a settings save
that writes it takes effect on the next page.
"""
import unittest
from unittest import mock

try:
    from app import web_analytics
    from app.tests import helpers
    from app.tests.test_page_gating import ADMIN_SESSION, PageRoutesBase
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False
    PageRoutesBase = unittest.TestCase

KEY = "security.cloudflare_web_analytics"
SCRIPT = "https://static.cloudflareinsights.com"


class FakeRedis:
    """Redis as both workers see it: one store. Only the calls the cache makes."""

    def __init__(self, store):
        self.store = store

    def get(self, key):
        return self.store.get(key)

    def set(self, key, value, ex=None):
        self.store[key] = value.encode() if isinstance(value, str) else value

    def delete(self, key):
        self.store.pop(key, None)


class BrokenRedis:
    def get(self, key):
        from redis.exceptions import ConnectionError
        raise ConnectionError("down")

    def set(self, key, value, ex=None):
        self.get(key)

    def delete(self, key):
        self.get(key)


def strict_csp() -> str:
    """The policy every response carried before the switch existed."""
    from app.config import settings
    connect = ["'self'"] + ([settings.authentik_url] if settings.authentik_url else []) + [
        s.strip() for s in settings.csp_connect_src.split(",") if s.strip()]
    frames = [s.strip() for s in settings.csp_frame_src.split(",") if s.strip()]
    parts = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https:",
        "worker-src 'self'",
        "media-src 'self' https://*.plex.direct:*",
        "frame-ancestors 'self'",
        "base-uri 'self'",
        "object-src 'none'",
    ]
    if frames:
        parts.append("frame-src " + " ".join(frames))
    parts.append("connect-src " + " ".join(connect))
    return "; ".join(parts)


def directives(csp: str) -> dict:
    out = {}
    for d in csp.split(";"):
        name, _, value = d.strip().partition(" ")
        assert name not in out, f"{name} appears twice"
        out[name] = value
    return out


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Base(PageRoutesBase):
    """Pages against an in-memory database and one Redis store."""

    def setUp(self):
        super().setUp()
        self.Session = helpers.make_sessionmaker()
        self.store = {}
        self.redis = FakeRedis(self.store)
        for p in (mock.patch.object(web_analytics, "SessionLocal", self.Session),
                  mock.patch.object(web_analytics, "_redis", side_effect=lambda: self.redis)):
            p.start()
            self.addCleanup(p.stop)

    def switch(self, value):
        db = self.Session()
        try:
            helpers.put(db, KEY, value)
        finally:
            db.close()

    def html_csps(self):
        """The CSP of each kind of HTML response: a shell page, the login page, static HTML."""
        out = {}
        for path, session in (("/news", ADMIN_SESSION), ("/login", None), ("/static/partials/shell-header.html", None)):
            r = self.get(path, session)
            self.assertEqual(r.status_code, 200, path)
            self.assertTrue(r.headers["content-type"].startswith("text/html"), path)
            out[path] = r.headers["content-security-policy"]
        return out


class WebAnalyticsCsp(Base):
    def test_the_shipped_default_is_off(self):
        from app.settings_registry import REGISTRY, seed_defaults
        self.assertEqual(REGISTRY[KEY].default, "false")
        self.assertEqual(REGISTRY[KEY].type, "bool")
        self.assertFalse(REGISTRY[KEY].public)
        self.assertEqual(seed_defaults()[KEY][0], "false")

    def test_off_leaves_every_csp_unchanged(self):
        for value in (None, "false"):           # no row, then the seeded row
            if value is not None:
                self.switch(value)
            self.store.clear()
            for path, csp in self.html_csps().items():
                self.assertEqual(csp, strict_csp(), (value, path))
            self.assertEqual(self.client.get("/static/css/theme.css").headers["content-security-policy"],
                             strict_csp())

    def test_on_adds_exactly_the_script_host_to_html(self):
        self.switch("true")
        want = directives(strict_csp())
        want["script-src"] = "'self' " + SCRIPT
        for path, csp in self.html_csps().items():
            self.assertEqual(directives(csp), want, path)
            self.assertEqual(csp, strict_csp().replace("script-src 'self';", f"script-src 'self' {SCRIPT};"),
                             path)

    def test_on_leaves_other_responses_alone(self):
        self.switch("true")
        r = self.client.get("/static/css/theme.css")
        self.assertEqual(r.headers["content-security-policy"], strict_csp())
        self.assertEqual(self.client.get("/static/js/shell.js").headers["content-security-policy"],
                         strict_csp())

    def test_the_answer_is_cached_in_redis(self):
        self.switch("true")
        self.html_csps()
        self.assertEqual(self.store[web_analytics.CACHE_KEY], b"1")
        # Further pages are answered from Redis, not the database.
        with mock.patch.object(web_analytics, "SessionLocal", side_effect=AssertionError("read the db")):
            self.assertIn(SCRIPT, self.html_csps()["/login"])

    def test_the_cache_is_shared_not_per_worker(self):
        # Nothing is kept in the process: what Redis holds (written by either
        # worker) is the answer at once.
        self.html_csps()
        self.assertEqual(self.store[web_analytics.CACHE_KEY], b"0")
        self.store[web_analytics.CACHE_KEY] = b"1"
        self.assertIn(SCRIPT, self.html_csps()["/login"])

    def test_redis_down_reads_the_database(self):
        self.switch("true")
        self.redis = BrokenRedis()
        self.assertIn(SCRIPT, self.html_csps()["/login"])

    def test_database_down_serves_the_strict_csp(self):
        with mock.patch.object(web_analytics, "SessionLocal", side_effect=RuntimeError("no db")), \
             self.assertLogs("app.web_analytics", "WARNING"):
            self.assertEqual(self.html_csps()["/login"], strict_csp())
        self.assertNotIn(web_analytics.CACHE_KEY, self.store)


class SavingTheSwitch(Base):
    """A save through the settings API reaches the next page on any worker:
    the cached answer (shared by both) is dropped as the save lands."""

    def setUp(self):
        super().setUp()
        self.api = helpers.api_client(self.Session, helpers.ADMIN, headers=helpers.SAME_ORIGIN)

    def tearDown(self):
        helpers.reset_overrides()      # before the base turns the rate limits back on
        super().tearDown()

    def save(self, value):
        r = self.api.put("/api/admin/settings/bulk", json={"settings": [{"key": KEY, "value": value}]})
        self.assertEqual(r.status_code, 200, r.text)

    def test_turning_it_on_and_off_takes_effect_on_the_next_page(self):
        self.assertNotIn(SCRIPT, self.html_csps()["/login"])     # caches "off"
        self.save("true")
        self.assertNotIn(web_analytics.CACHE_KEY, self.store)
        self.assertIn(SCRIPT, self.html_csps()["/login"])          # caches "on"
        self.save("false")
        self.assertEqual(self.html_csps()["/login"], strict_csp())

    def test_an_import_that_changes_it_takes_effect_too(self):
        self.html_csps()
        data = {"format": "webservarr-settings", "format_version": 1, "settings": {KEY: "true"}}
        preview = self.api.post("/api/admin/settings/import?dry_run=true", json={"data": data})
        self.assertEqual(preview.status_code, 200, preview.text)
        r = self.api.post("/api/admin/settings/import?dry_run=false",
                          json={"data": data, "diff_token": preview.json()["diff_token"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn(KEY, r.json()["applied"])
        self.assertIn(SCRIPT, self.html_csps()["/login"])

    def test_a_save_of_other_keys_keeps_the_cache(self):
        self.html_csps()
        r = self.api.put("/api/admin/settings/bulk",
                         json={"settings": [{"key": "branding.tagline", "value": "Hello"}]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn(web_analytics.CACHE_KEY, self.store)

    def test_a_failed_clear_is_logged_not_raised(self):
        self.redis = BrokenRedis()
        with self.assertLogs("app.web_analytics", "WARNING"):
            self.save("true")


class SettingsSwitch(unittest.TestCase):
    """Settings > General carries the switch, with its one line of help, in
    the card the backup import locks."""

    def test_the_general_tab_has_the_switch(self):
        import re
        from pathlib import Path
        src = (Path(__file__).resolve().parents[1] / "static" / "js" / "settings" / "general.js").read_text(
            encoding="utf-8")
        site = re.search(r"\n  function siteCard\(.*?\n  }\n", src, re.S).group(0)
        self.assertRegex(site, r"api\.toggle\(\{\s*key: 'security\.cloudflare_web_analytics'")
        self.assertIn("help: 'Allow Cloudflare Web Analytics\u2019 script (only if your site is behind "
                      "Cloudflare with Web Analytics on)'", site)
        keys = re.search(r"var TAB_KEYS = \[([^\]]*)\]", src).group(1)
        self.assertIn("'security.cloudflare_web_analytics'", keys)


if __name__ == "__main__":
    unittest.main()
