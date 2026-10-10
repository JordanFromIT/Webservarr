"""
Settings > General > Debug mode (system.debug_mode): the switch for the
browser debug tools that ?ws-debug= loads (router.js, debug-leaks.js).

Off by default. The tools are client-side only, so the server's part is the
one bit the client trusts: the page's #ws-data carries debug_mode: true only
for an admin while the setting is on, and leaves the key out for everyone
else (signed out, a member, an admin while it is off). The setting is not
public, so /api/branding and the branding payload never carry it.
The client's side (debugAllowed, debugFlags) is app/tests/js/debug_leaks.mjs
and app/tests/js/router_runtime.mjs.
"""
import json
import re
import unittest
from unittest import mock

from app.settings_registry import REGISTRY, public_defaults, seed_defaults, validate_value

try:
    from fastapi.testclient import TestClient

    from app import pages
    from app.auth import session_manager
    from app.config import settings
    from app.main import app
    from app.routers.branding import EMPTY_WIKI_HOOKS, build_branding, load_branding
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

KEY = "system.debug_mode"
ADMIN_SESSION = {"username": "admin", "display_name": "Admin", "is_admin": "true",
                 "auth_method": "simple", "avatar_url": ""}
MEMBER_SESSION = {"username": "sam", "display_name": "Sam", "is_admin": "false",
                  "auth_method": "plex", "avatar_url": ""}


def data_of(text: str) -> dict:
    return json.loads(re.search(r'<script id="ws-data" type="application/json">(.*?)</script>', text, re.S).group(1))


class TheSetting(unittest.TestCase):
    def test_it_is_an_admin_only_switch_that_ships_off(self):
        d = REGISTRY[KEY]
        self.assertEqual(d.type, "bool")
        self.assertEqual(d.default, "false")
        self.assertFalse(d.public)
        self.assertFalse(d.secret)
        self.assertNotIn(KEY, public_defaults())
        self.assertEqual(seed_defaults()[KEY][0], "false")

    def test_only_true_or_false_is_saved(self):
        self.assertIsNone(validate_value(KEY, "true"))
        self.assertIsNone(validate_value(KEY, "false"))
        self.assertIsNotNone(validate_value(KEY, "yes"))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class TheDatabaseRow(unittest.TestCase):
    """load_context reads the row; a missing row is the default, off."""

    def flags_with(self, value):
        maker = helpers.make_sessionmaker()
        if value is not None:
            db = maker()
            helpers.put(db, KEY, value)
            db.close()
        with mock.patch.object(pages, "SessionLocal", maker):
            branding, flags = pages.load_context(True)
        return branding, flags

    def test_on_only_when_the_row_says_true(self):
        self.assertIs(self.flags_with(None)[1]["debug_mode"], False)
        self.assertIs(self.flags_with("false")[1]["debug_mode"], False)
        self.assertIs(self.flags_with("true")[1]["debug_mode"], True)

    def test_the_branding_payload_never_carries_it(self):
        branding, _flags = self.flags_with("true")
        self.assertNotIn("debug", json.dumps(branding).lower())
        maker = helpers.make_sessionmaker()
        db = maker()
        helpers.put(db, KEY, "true")
        try:
            self.assertNotIn("debug", json.dumps(load_branding(db, True)).lower())
        finally:
            db.close()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ThePagesDataBlock(unittest.TestCase):
    """Signed out, member and admin, with the setting on and off: only the
    admin with it on is told."""

    def setUp(self):
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        self.db_patch = mock.patch.object(pages, "SessionLocal", helpers.make_sessionmaker())
        self.db_patch.start()
        helpers.set_rate_limits(False)
        self.client = TestClient(app)
        self.client.cookies.set(settings.session_cookie_name, "test-session")

    def tearDown(self):
        self.db_patch.stop()
        self.setup_patch.stop()
        helpers.set_rate_limits(True)

    def data(self, path, session, on):
        b = build_branding({}, {}, None, dict(EMPTY_WIKI_HOOKS))
        with mock.patch.object(session_manager, "get_session", mock.AsyncMock(return_value=session)), \
             mock.patch.object(pages, "load_context", return_value=(b, {"netdata": False, "debug_mode": on})):
            r = self.client.get(path, follow_redirects=False)
        self.assertEqual(r.status_code, 200, path)
        return data_of(r.text)

    def test_signed_out_is_never_told(self):
        for on in (False, True):
            self.assertNotIn("debug_mode", self.data("/login", None, on), on)

    def test_a_member_is_never_told(self):
        for path in ("/", "/calendar"):
            for on in (False, True):
                self.assertNotIn("debug_mode", self.data(path, MEMBER_SESSION, on), (path, on))

    def test_an_admin_is_told_only_while_it_is_on(self):
        for path in ("/", "/settings"):
            self.assertNotIn("debug_mode", self.data(path, ADMIN_SESSION, False), path)
            self.assertIs(self.data(path, ADMIN_SESSION, True)["debug_mode"], True, path)


if __name__ == "__main__":
    unittest.main()
