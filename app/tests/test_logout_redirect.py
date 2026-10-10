"""
GET /auth/logout sends an Authentik sign-in to the provider's end-session URL.

The Authentik address is stored as typed in Settings, often with a trailing
slash. Joined naively that gave "https://auth.example.com//application/o/...",
which Authentik answers with its "Not Found" page instead of signing out.
"""
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from app.tests import helpers

OIDC_SESSION = {"username": "sam", "display_name": "Sam", "is_admin": "false",
                "auth_method": "oidc", "id_token": "test-id-token"}


class LogoutRedirectTests(unittest.TestCase):
    def setUp(self):
        from app.auth import session_manager

        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        # The setup-redirect middleware reads the real database, not the override.
        for p in (mock.patch("app.routers.setup.is_setup_completed", return_value=True),
                  mock.patch.object(session_manager, "get_session",
                                    mock.AsyncMock(return_value=OIDC_SESSION)),
                  mock.patch.object(session_manager, "delete_session", mock.AsyncMock())):
            p.start()
            self.addCleanup(p.stop)
        self.client = helpers.api_client(self.Session)

    def tearDown(self):
        helpers.reset_overrides()
        self.db.close()

    def logout_location(self) -> str:
        from app.config import settings
        self.client.cookies.set(settings.session_cookie_name, "test-session")
        r = self.client.get("/auth/logout", follow_redirects=False)
        self.assertEqual(r.status_code, 302)
        return r.headers["location"]

    def test_trailing_slash_address_gives_single_slash_end_session_url(self):
        helpers.put(self.db, "integration.authentik.url", "https://auth.example.com/")
        helpers.put(self.db, "integration.authentik.app_slug", "webservarr")
        url = urlsplit(self.logout_location())
        self.assertEqual(f"{url.scheme}://{url.netloc}{url.path}",
                         "https://auth.example.com/application/o/webservarr/end-session/")
        query = parse_qs(url.query)
        self.assertEqual(query["post_logout_redirect_uri"], ["http://testserver/login"])
        self.assertEqual(query["id_token_hint"], ["test-id-token"])

    def test_address_without_trailing_slash_is_unchanged(self):
        helpers.put(self.db, "integration.authentik.url", "https://auth.example.com")
        url = urlsplit(self.logout_location())
        self.assertEqual(f"{url.scheme}://{url.netloc}{url.path}",
                         "https://auth.example.com/application/o/webservarr/end-session/")


if __name__ == "__main__":
    unittest.main()
