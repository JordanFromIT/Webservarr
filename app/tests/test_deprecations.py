"""
The app's own code raises none of the dependency deprecations it used to.

Each import check runs in a fresh interpreter, so a module another test
already imported cannot hide the warning.
"""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

try:
    from app import auth  # noqa: F401 - the app's dependencies are installed
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


if __name__ == "__main__":
    unittest.main()
