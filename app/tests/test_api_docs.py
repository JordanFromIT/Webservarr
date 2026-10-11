"""
The interactive API docs and the schema behind them (security audit
2026-10-10, I4) are served only when APP_DEBUG is on. Outside debug they
answer like any unknown address, while app.openapi() still builds the schema
for the tests that walk the route map.
"""
import unittest
from unittest import mock

from app.tests import helpers

try:
    import fastapi  # noqa: F401 - only present with the app's dependencies
    HAVE_APP = True
except ImportError:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

if HAVE_APP:
    from app.config import settings


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
@unittest.skipIf(HAVE_APP and settings.app_debug, "APP_DEBUG is on, so the docs are meant to be served")
class DocsOffOutsideDebug(unittest.TestCase):
    def setUp(self):
        p = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        p.start()
        self.addCleanup(p.stop)
        self.client = helpers.api_client(helpers.make_sessionmaker())
        self.addCleanup(helpers.reset_overrides)

    def test_docs_redoc_and_schema_are_not_found(self):
        for path in ("/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path, follow_redirects=False).status_code, 404)

    def test_the_schema_is_still_built_in_process(self):
        from app.main import app
        self.assertIn("/api/webhooks/kometa/{token}", app.openapi()["paths"])


if __name__ == "__main__":
    unittest.main()
