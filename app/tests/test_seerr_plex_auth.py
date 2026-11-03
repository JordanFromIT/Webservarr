"""
authenticate_with_plex_token asks Seerr to check a Plex token, and Seerr in
turn asks plex.tv, so the call is slow when plex.tv is. A 5 second limit with
no retry turned one plex.tv hiccup into "Could not authenticate with Seerr"
(the log line had an empty message, because str() of an httpx timeout is
empty). The call now waits longer, tries a timeout, connection failure or 5xx
once more, and logs the exception class. A 401/403 is never retried.
"""
import asyncio
import unittest
from unittest import mock

try:
    import httpx
    from app.integrations import seerr
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

CONFIG = {"url": "http://seerr.invalid", "api_key": "k"}
SID = "s%3Aabc123"


def _ok():
    return httpx.Response(200, headers={"set-cookie": f"connect.sid={SID}; Path=/; HttpOnly"})


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class PlexAuth(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.client_kwargs = []
        self.script = []
        real_client = httpx.AsyncClient

        def handler(request):
            self.calls.append(request)
            step = self.script.pop(0)
            if isinstance(step, Exception):
                raise step
            return step

        def client(**kwargs):
            self.client_kwargs.append(kwargs)
            return real_client(transport=httpx.MockTransport(handler), **kwargs)

        # An unscripted extra call pops an empty list and fails the test.
        for p in (mock.patch.object(seerr, "_get_config", return_value=dict(CONFIG)),
                  mock.patch.object(seerr.httpx, "AsyncClient", client),
                  mock.patch.object(seerr.asyncio, "sleep", mock.AsyncMock())):
            p.start()
            self.addCleanup(p.stop)

    def run_auth(self):
        return asyncio.run(seerr.authenticate_with_plex_token("plex-token"))

    def test_timeout_then_success_returns_the_sid(self):
        self.script = [httpx.ReadTimeout(""), _ok()]
        self.assertEqual(self.run_auth(), SID)
        self.assertEqual(len(self.calls), 2)

    def test_two_timeouts_give_up(self):
        self.script = [httpx.ReadTimeout(""), httpx.ReadTimeout("")]
        self.assertIsNone(self.run_auth())
        self.assertEqual(len(self.calls), 2)

    def test_connect_error_is_retried(self):
        self.script = [httpx.ConnectError("refused"), _ok()]
        self.assertEqual(self.run_auth(), SID)

    def test_server_error_then_success_returns_the_sid(self):
        self.script = [httpx.Response(500), _ok()]
        self.assertEqual(self.run_auth(), SID)
        self.assertEqual(len(self.calls), 2)

    def test_two_server_errors_give_up(self):
        self.script = [httpx.Response(502), httpx.Response(502)]
        self.assertIsNone(self.run_auth())
        self.assertEqual(len(self.calls), 2)

    def test_a_refused_token_is_tried_once(self):
        for status in (401, 403):
            with self.subTest(status=status):
                self.calls.clear()
                self.script = [httpx.Response(status)]
                self.assertIsNone(self.run_auth())
                self.assertEqual(len(self.calls), 1)

    def test_a_200_without_the_cookie_is_none(self):
        self.script = [httpx.Response(200)]
        self.assertIsNone(self.run_auth())
        self.assertEqual(len(self.calls), 1)

    def test_the_wait_is_longer_than_the_shared_timeout(self):
        self.script = [_ok()]
        self.run_auth()
        timeout = self.client_kwargs[0]["timeout"]
        self.assertGreater(timeout.read, seerr.TIMEOUT)
        self.assertEqual(timeout.connect, 5.0)

    def test_the_timeout_log_names_the_exception_class(self):
        self.script = [httpx.ReadTimeout(""), httpx.ReadTimeout("")]
        with self.assertLogs("app.integrations.seerr", level="WARNING") as logs:
            self.run_auth()
        text = "\n".join(logs.output)
        self.assertIn("ReadTimeout", text)
        self.assertIn("ReadTimeout('')", text)
        self.assertRegex(text, r"after \d+\.\ds")

    def test_no_url_means_no_call(self):
        self.script = []
        with mock.patch.object(seerr, "_get_config", return_value={"url": "", "api_key": ""}):
            self.assertIsNone(self.run_auth())
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
