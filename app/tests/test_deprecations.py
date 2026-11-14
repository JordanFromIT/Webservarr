"""
The app's own code raises none of the dependency deprecations it used to.

authlib's OIDC client runs on httpx2 (with only plain httpx installed, authlib
falls back to it and warns that the backend is deprecated). Each import check runs in a fresh interpreter, so a module another test
already imported cannot hide the warning.
"""
import asyncio
import json
import os
import subprocess
import sys
import unittest
import warnings
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

try:
    from app import auth
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

try:
    import httpx2
except ImportError:  # failed in AuthlibOnHttpx2.setUp, never skipped
    httpx2 = None

ROOT = Path(__file__).resolve().parents[2]


def warnings_on_import(module: str) -> list:
    """(category name, message) of every warning importing ``module`` raises
    in a fresh interpreter."""
    code = (
        "import json, warnings\n"
        "with warnings.catch_warnings(record=True) as caught:\n"
        "    warnings.simplefilter('always')\n"
        f"    import {module}\n"
        "print(json.dumps([[w.category.__name__, str(w.message)] for w in caught]))\n"
    )
    done = subprocess.run(
        [sys.executable, "-c", code], cwd=ROOT, env=os.environ.copy(),
        capture_output=True, text=True, timeout=120,
    )
    if done.returncode != 0:
        raise AssertionError(f"importing {module} failed:\n{done.stderr}")
    return [tuple(w) for w in json.loads(done.stdout.strip().splitlines()[-1])]


@unittest.skipUnless(HAVE_APP, "app dependencies not installed")
class DeclarativeBaseFromOrm(unittest.TestCase):
    def test_importing_database_raises_no_moved_in_20_warning(self):
        caught = warnings_on_import("app.database")
        self.assertEqual([w for w in caught if w[0] == "MovedIn20Warning"], [])


@unittest.skipUnless(HAVE_APP, "app dependencies not installed")
class RedisClosedWithAclose(unittest.TestCase):
    """Both async Redis owners shut their client with aclose(). The client
    never connects (nothing is sent before close), so no server is needed."""

    def closing_warnings(self, close) -> list:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            asyncio.run(close())
        return [str(w.message) for w in caught if "deprecated close" in str(w.message)]

    def test_session_manager_close(self):
        import redis.asyncio as aioredis

        manager = auth.SessionManager()
        manager._redis = aioredis.from_url("redis://127.0.0.1:1/0")
        self.assertEqual(self.closing_warnings(manager.close), [])

    def test_stopping_the_poller(self):
        import redis.asyncio as aioredis

        from app.services import notification_poller as poller

        with mock.patch.object(poller, "_redis", aioredis.from_url("redis://127.0.0.1:1/0")), \
                mock.patch.object(poller, "_stop_event", None), \
                mock.patch.object(poller, "_lease", None):
            self.assertEqual(self.closing_warnings(poller.stop_poller), [])
            self.assertIsNone(poller._redis)


@unittest.skipUnless(HAVE_APP, "app dependencies not installed")
class AuthlibOnHttpx2(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(httpx2, "httpx2 is not installed (requirements.txt)")
        self.client = auth.OIDCClient(
            authentik_url="https://sso.example.test",
            client_id="cid",
            client_secret="secret",
            redirect_uri="https://app.example.test/auth/callback",
        )

    def test_importing_auth_raises_no_authlib_deprecation(self):
        caught = warnings_on_import("app.auth")
        self.assertEqual([w for w in caught if w[0] == "AuthlibDeprecationWarning"], [])

    def test_the_oauth_client_is_an_httpx2_client(self):
        self.assertTrue(issubclass(auth.AsyncOAuth2Client, httpx2.AsyncClient))

    def test_the_authorization_url_carries_pkce_state_and_nonce(self):
        url = asyncio.run(self.client.get_authorization_url(
            "the-state", code_challenge="the-challenge", nonce="the-nonce",
        ))
        parts = urlsplit(url)
        query = parse_qs(parts.query)
        self.assertEqual(f"{parts.scheme}://{parts.netloc}{parts.path}", self.client.authorize_url)
        self.assertEqual(query["state"], ["the-state"])
        self.assertEqual(query["code_challenge"], ["the-challenge"])
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertEqual(query["nonce"], ["the-nonce"])
        self.assertEqual(query["client_id"], ["cid"])

    def test_the_token_exchange_posts_through_httpx2(self):
        seen = []

        def token_endpoint(request):
            seen.append(request)
            return httpx2.Response(200, json={
                "access_token": "at", "token_type": "Bearer", "id_token": "it",
            })

        real_client = auth.AsyncOAuth2Client

        def offline_client(**kwargs):
            return real_client(transport=httpx2.MockTransport(token_endpoint), **kwargs)

        with mock.patch.object(auth, "AsyncOAuth2Client", offline_client):
            token = asyncio.run(self.client.exchange_code_for_token("the-code", code_verifier="the-verifier"))

        self.assertEqual(token["access_token"], "at")
        self.assertEqual(token["id_token"], "it")
        self.assertEqual(len(seen), 1)
        request = seen[0]
        self.assertEqual(request.method, "POST")
        self.assertEqual(str(request.url), self.client.token_url)
        form = parse_qs(request.content.decode())
        self.assertEqual(form["grant_type"], ["authorization_code"])
        self.assertEqual(form["code"], ["the-code"])
        self.assertEqual(form["code_verifier"], ["the-verifier"])
        self.assertEqual(form["redirect_uri"], [self.client.redirect_uri])
        # client_secret_basic: the client authenticates with an Authorization header.
        self.assertTrue(request.headers["authorization"].startswith("Basic "))

    def test_httpx2_request_lines_stay_out_of_the_log(self):
        # M7: request URLs can carry secrets, so the request loggers sit at WARNING.
        import logging

        import app.main  # noqa: F401 - sets the logger levels

        for name in ("httpx", "httpcore", "httpx2", "httpcore2"):
            self.assertEqual(logging.getLogger(name).level, logging.WARNING, name)


if __name__ == "__main__":
    unittest.main()
