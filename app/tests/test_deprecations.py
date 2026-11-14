"""
The app's own code raises none of the dependency deprecations it used to.

Each import check runs in a fresh interpreter, so a module another test
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

try:
    from app import auth
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

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


if __name__ == "__main__":
    unittest.main()
