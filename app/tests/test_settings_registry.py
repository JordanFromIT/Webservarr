"""
The settings registry is the one definition of every operator setting.

These tests pin that nothing the app used to seed or read was lost, that the
validation rules reject what the Settings page must never store, and that the
page order always normalises to something the nav can render.
"""
import json
import unittest

try:
    from app import settings_registry as reg
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

# Keys app/seed.py DEFAULT_SETTINGS held before v1.11 (copied, not imported, so
# the test keeps its meaning after seed.py starts deriving from the registry).
OLD_SEED_KEYS = [
    "branding.app_name", "branding.tagline", "branding.logo_url",
    "theme.color_primary", "theme.color_secondary", "theme.color_accent", "theme.color_text",
    "theme.color_text_secondary", "theme.color_background", "theme.color_media_movie",
    "theme.color_media_tv", "theme.color_media_book", "theme.font", "theme.custom_css",
    "features.show_requests", "features.show_simple_auth", "features.login_backgrounds",
    "sidebar.label_home", "sidebar.label_requests", "sidebar.label_requests_embed",
    "sidebar.label_issues", "sidebar.label_tickets", "sidebar.sublabel_home",
    "sidebar.sublabel_requests", "sidebar.sublabel_requests_embed", "sidebar.sublabel_issues",
    "sidebar.sublabel_calendar", "sidebar.sublabel_tickets", "sidebar.sublabel_library",
    "sidebar.sublabel_settings", "sidebar.label_calendar", "sidebar.label_settings",
    "sidebar.label_wiki", "sidebar.sublabel_wiki", "sidebar.enabled_wiki", "sidebar.new_wiki",
    "icon.nav_wiki", "wiki.hook_tickets", "wiki.hook_issues", "wiki.hook_playback",
    "icon.nav_home", "icon.nav_requests", "icon.nav_requests_embed", "icon.nav_issues",
    "icon.nav_tickets", "icon.nav_calendar", "icon.nav_settings", "icon.sidebar_logo",
    "icon.section_services", "icon.section_news", "icon.section_streams", "icon.section_releases",
    "netdata.cpu_label", "netdata.ram_label", "netdata.net_label", "netdata.net_unit", "netdata.net_max",
    "notifications.poll_interval_seerr", "notifications.poll_interval_monitors",
    "notifications.poll_interval_news", "integration.authentik.url", "integration.authentik.client_id",
    "integration.authentik.client_secret", "integration.authentik.app_slug", "integration.kavita.url",
    "features.show_books", "sidebar.label_library", "icon.nav_library", "integration.chaptarr.url",
    "integration.chaptarr.api_key", "integration.chaptarr.root_folder",
    "integration.chaptarr.quality_profile_id", "integration.chaptarr.metadata_profile_id",
    "integration.chaptarr.audiobook_root_folder", "integration.chaptarr.audiobook_quality_profile_id",
    "integration.chaptarr.audiobook_metadata_profile_id", "integration.nyt.api_key",
    "sidebar.enabled_home", "sidebar.enabled_requests", "sidebar.enabled_requests_embed",
    "sidebar.enabled_issues", "sidebar.enabled_calendar", "sidebar.enabled_tickets",
    "sidebar.enabled_library", "features.show_tickets", "notifications.poll_interval_tickets",
]
# Keys only branding.DEFAULTS knew about before v1.11 (spec 4.1).
OLD_BRANDING_ONLY_KEYS = [
    "features.show_plex_auth", "features.show_authentik_auth", "sidebar.new_home",
    "sidebar.new_requests", "sidebar.new_requests_embed", "sidebar.new_issues",
    "sidebar.new_calendar", "sidebar.new_tickets", "sidebar.new_library", "sidebar.new_settings",
    "icon.section_requests", "news.homepage_count", "news.homepage_max_age_days",
]
# Keys the old Settings page wrote that neither table seeded.
OLD_UI_ONLY_KEYS = [
    "system.admin_email", "integration.plex.url", "integration.plex.token",
    "integration.seerr.url", "integration.seerr.api_key", "integration.sonarr.url",
    "integration.sonarr.api_key", "integration.radarr.url", "integration.radarr.api_key",
    "integration.uptime_kuma.url", "integration.uptime_kuma.slug", "integration.netdata.url",
    "integration.netdata.api_key",
]
SECRETS = {
    "integration.plex.token", "integration.seerr.api_key", "integration.chaptarr.api_key",
    "integration.nyt.api_key", "integration.sonarr.api_key", "integration.radarr.api_key",
    "integration.netdata.api_key", "integration.authentik.client_secret",
}


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Coverage(unittest.TestCase):
    def test_nothing_the_app_used_is_missing(self):
        for key in OLD_SEED_KEYS + OLD_BRANDING_ONLY_KEYS + OLD_UI_ONLY_KEYS:
            self.assertIsNotNone(reg.get_def(key), key)

    def test_uptime_kuma_api_key_is_retired(self):
        d = reg.get_def("integration.uptime_kuma.api_key")
        self.assertTrue(d.deprecated)
        self.assertNotIn("integration.uptime_kuma.api_key", [x.key for x in reg.active_defs()])
        self.assertNotIn("integration.uptime_kuma.api_key", reg.seed_defaults())

    def test_every_default_passes_its_own_validation(self):
        for d in reg.REGISTRY.values():
            self.assertIn(d.type, reg.TYPES, d.key)
            self.assertIsNone(reg.validate_value(d.key, d.default), d.key)
            if d.type == "enum":
                self.assertTrue(d.choices, d.key)
            if d.type == "int":
                self.assertIsNotNone(d.min, d.key)
                self.assertIsNotNone(d.max, d.key)

    def test_secrets_are_exactly_the_credentials(self):
        active_secrets = {d.key for d in reg.active_defs() if d.secret}
        self.assertEqual(active_secrets, SECRETS)
        for key in SECRETS:
            self.assertFalse(reg.get_def(key).public, key)

    def test_new_keys_exist_with_expected_defaults(self):
        self.assertEqual(json.loads(reg.REGISTRY["pages.order"].default), reg.DEFAULT_PAGE_ORDER)
        self.assertEqual(reg.REGISTRY["requests.source"].default, "native")
        for sid in reg.HOME_SECTION_IDS:
            self.assertEqual(reg.REGISTRY["home.section_" + sid].default, "true")

    def test_seed_defaults_respect_flags(self):
        seeded = reg.seed_defaults()
        self.assertIn("pages.order", seeded)
        self.assertIn("home.section_news", seeded)
        self.assertNotIn("system.admin_email", seeded)
        self.assertNotIn("integration.plex.url", seeded)
        value, description = seeded["branding.app_name"]
        self.assertEqual(value, "WebServarr")
        self.assertTrue(description)

    def test_page_defaults_cover_every_sidebar_page(self):
        self.assertEqual(set(reg.PAGE_DEFAULTS), set(reg.SIDEBAR_PAGE_IDS))
        for pid, (label, _sub, icon) in reg.PAGE_DEFAULTS.items():
            self.assertEqual(reg.REGISTRY["sidebar.label_" + pid].default, label)
            self.assertEqual(reg.REGISTRY["icon.nav_" + pid].default, icon)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Validation(unittest.TestCase):
    def bad(self, key, value):
        self.assertIsNotNone(reg.validate_value(key, value), f"{key}={value!r} should be rejected")

    def ok(self, key, value):
        self.assertIsNone(reg.validate_value(key, value), f"{key}={value!r} should be accepted")

    def test_unknown_key(self):
        self.assertEqual(reg.validate_value("nope.nothing", "x"), "Unknown setting")
        self.assertEqual(reg.validate_value("system.secret_key", "x"), "Unknown setting")

    def test_urls(self):
        self.bad("integration.sonarr.url", "192.168.1.5:8989")      # no scheme
        self.bad("integration.sonarr.url", "http://")               # no host
        self.bad("integration.sonarr.url", "ftp://192.168.1.5")
        self.bad("integration.sonarr.url", "http://127.0.0.1:8989") # SSRF guard
        self.bad("integration.authentik.url", "auth.example.com")   # schemeless Authentik (Kavita follow-up)
        self.ok("integration.sonarr.url", "http://192.168.1.5:8989")
        self.ok("integration.sonarr.url", "")
        self.ok("branding.logo_url", "/static/uploads/logo-1a2b3c4d.png")
        self.ok("branding.logo_url", "https://cdn.example.com/logo.png")
        self.bad("branding.logo_url", "//evil.example/logo.png")
        self.bad("branding.logo_url", "/\\evil.example/logo.png")     # a browser reads "/\\" as "//"
        self.bad("branding.logo_url", "javascript:alert(1)")

    def test_urls_that_do_not_parse_are_refused_not_raised(self):
        # urlsplit raises on an unclosed IPv6 bracket; that must be a refusal.
        self.bad("integration.sonarr.url", "http://[::1")
        self.bad("branding.logo_url", "http://[::1")
        # An out-of-range port would be saved, then blanked by the branding builder.
        self.bad("branding.logo_url", "https://example.com:99999/x.png")
        self.bad("integration.sonarr.url", "http://192.168.1.5:99999")
        # A same-origin SVG sprite reference keeps its fragment.
        self.ok("branding.logo_url", "/icons.svg#logo")

    def test_ints(self):
        self.bad("news.homepage_count", "0")
        self.bad("news.homepage_count", "21")
        self.bad("news.homepage_count", "abc")
        self.bad("news.homepage_count", "1.5")
        self.bad("news.homepage_count", "٣")                   # a non-ASCII digit
        self.bad("notifications.poll_interval_news", "29")
        self.bad("notifications.poll_interval_news", "3601")
        self.ok("notifications.poll_interval_news", "30")
        self.ok("integration.chaptarr.quality_profile_id", "")
        # Numbers, colours, icons and choices can't be blank.
        self.bad("news.homepage_count", "")
        self.bad("theme.color_primary", "")
        self.bad("icon.nav_home", "")
        self.bad("requests.source", "")
        self.bad("pages.order", "")

    def test_enums_bools_colours_icons(self):
        self.bad("requests.source", "iframe")
        self.ok("requests.source", "seerr_embed")
        self.bad("netdata.net_unit", "gbps")
        self.bad("features.login_backgrounds", "yes")
        self.ok("features.login_backgrounds", "false")
        self.bad("theme.color_primary", "red")
        self.bad("theme.color_primary", "#12579")
        self.ok("theme.color_primary", "#ff00AA")
        self.bad("icon.nav_home", "Home Icon")
        self.ok("icon.nav_home", "home_work")

    def test_text_rules(self):
        self.bad("sidebar.label_home", "")
        self.ok("sidebar.sublabel_home", "")
        self.ok("branding.app_name", "")
        self.bad("branding.app_name", "x" * 81)
        self.bad("theme.font", 'Evil"; @import')
        self.bad("system.admin_email", "not-an-email")
        self.ok("system.admin_email", "")
        self.ok("system.admin_email", "admin@example.com")
        self.bad("wiki.hook_tickets", "Not A Slug")

    def test_unstorable_characters(self):
        # A lone UTF-16 surrogate can't be encoded, so SQLite can't store it:
        # refuse it with a reason instead of letting the write 500.
        msg = "Contains characters that can't be stored"
        self.assertEqual(reg.validate_value("branding.app_name", "Name \ud800"), msg)
        self.assertEqual(reg.validate_value("branding.logo_url", "/logo\udfff.png"), msg)
        self.assertEqual(reg.validate_value("integration.sonarr.url", "http://192.168.1.5/\ud800"), msg)
        self.assertEqual(reg.validate_value("monitor.3.icon", "\ud800"), msg)
        self.bad("branding.app_name", "Name\x00")

    def test_page_order(self):
        good = json.dumps(reg.DEFAULT_PAGE_ORDER)
        self.ok("pages.order", good)
        self.ok("pages.order", json.dumps(["home", "wiki", "requests", "issues", "calendar",
                                           "tickets", "library", "settings"]))
        self.bad("pages.order", json.dumps(["requests", "home", "issues", "calendar", "tickets",
                                            "library", "wiki", "settings"]))       # home not first
        self.bad("pages.order", json.dumps(reg.DEFAULT_PAGE_ORDER[:-2] + ["settings"]))  # wiki missing
        self.bad("pages.order", json.dumps(reg.DEFAULT_PAGE_ORDER[:-1] + ["news", "settings"]))
        self.bad("pages.order", json.dumps(["home", "home"] + reg.DEFAULT_PAGE_ORDER[1:]))
        self.bad("pages.order", "not json")

    def test_monitor_patterns(self):
        self.ok("monitor.12.enabled", "false")
        self.ok("monitor.12.icon", "https://cdn.example.com/icons/plex.png")
        self.bad("monitor.12.icon", "<script>")
        self.assertEqual(reg.validate_value("monitor.abc.enabled", "true"), "Unknown setting")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class UserData(unittest.TestCase):
    """Per-user rows share the settings table but are not operator settings."""
    NOTIFY = "notify.0123456789abcdef.request"

    def test_recognised(self):
        for key in (self.NOTIFY, "notify.fedcba9876543210.ticket"):
            self.assertTrue(reg.is_user_data(key), key)
        for key in ("notify.short.request", "notify.0123456789ABCDEF.request",
                    "notifications.poll_interval_news", "branding.app_name"):
            self.assertFalse(reg.is_user_data(key), key)

    def test_never_defined_seeded_or_writable(self):
        self.assertIsNone(reg.get_def(self.NOTIFY))
        self.assertNotIn(self.NOTIFY, reg.seed_defaults())
        self.assertEqual(reg.validate_value(self.NOTIFY, "false"), reg.USER_DATA_MESSAGE)
        self.assertFalse(any(k.startswith("notify.") for k in reg.seed_defaults()))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Helpers(unittest.TestCase):
    def test_normalize_page_order(self):
        default = reg.DEFAULT_PAGE_ORDER
        self.assertEqual(reg.normalize_page_order(None), default)
        self.assertEqual(reg.normalize_page_order("garbage"), default)
        self.assertEqual(reg.normalize_page_order('{"a": 1}'), default)
        # Stale list missing a page (a future page added later): appended before settings.
        stale = json.dumps(["home", "calendar", "requests", "issues", "tickets", "library", "settings"])
        self.assertEqual(reg.normalize_page_order(stale),
                         ["home", "calendar", "requests", "issues", "tickets", "library", "wiki", "settings"])
        # Unknown and duplicate ids dropped; home/settings pinned.
        messy = json.dumps(["settings", "wiki", "news", "wiki", "home"])
        self.assertEqual(reg.normalize_page_order(messy),
                         ["home", "wiki", "requests", "issues", "calendar", "tickets", "library", "settings"])

    def test_mask(self):
        self.assertEqual(reg.mask("integration.plex.token", "abc"), reg.MASK)
        self.assertEqual(reg.mask("integration.plex.token", ""), "")
        self.assertEqual(reg.mask("integration.plex.token", None), "")
        self.assertEqual(reg.mask("branding.app_name", "My Site"), "My Site")

    def test_meta_shape(self):
        m = reg.meta_for(reg.REGISTRY["news.homepage_count"])
        self.assertEqual(m["type"], "int")
        self.assertEqual((m["min"], m["max"]), (1, 20))
        self.assertEqual(m["default"], "3")
        for field in ("secret", "public", "description", "choices", "max_length",
                      "allow_empty", "allow_relative", "pattern"):
            self.assertIn(field, m)


if __name__ == "__main__":
    unittest.main()
