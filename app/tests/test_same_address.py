"""
same_address() against the shared cases (same_address_vectors.json).

The Integrations tab repeats the rule in JavaScript (sameAddress in
integrations.js) to decide whether a Kavita save warns about resetting
everyone's eBooks connection. Both sides run the same cases: this file the
Python one, app/tests/js/same_address.mjs the JavaScript one, in the CI job
js-checks (the Python image has no JavaScript). The check below keeps the
file that job runs pointed at the shared cases and the real function. (The
workflow itself is not in the image the suite runs on, so the job is checked
by CI listing it, not from here.)
"""
import json
import unittest
from pathlib import Path

try:
    from app.integrations.config import same_address
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False

TESTS = Path(__file__).resolve().parent
VECTORS = json.loads((TESTS / "same_address_vectors.json").read_text(encoding="utf-8"))["cases"]


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SharedCases(unittest.TestCase):
    def test_every_case_both_ways(self):
        for c in VECTORS:
            with self.subTest(c["why"]):
                self.assertIs(same_address(c["a"], c["b"]), c["same"])
                self.assertIs(same_address(c["b"], c["a"]), c["same"])

    def test_the_cases_cover_what_drifted(self):
        whys = " | ".join(c["why"] for c in VECTORS)
        for topic in ("trailing ?", "trailing #", "port", "scheme", "path", "userinfo", "IPv6 compressed",
                      "host case", "whitespace", "double slash"):
            self.assertIn(topic, whys)


class TheJavaScriptSideRuns(unittest.TestCase):
    def test_the_check_reads_the_shared_cases_and_the_real_function(self):
        js = (TESTS / "js" / "same_address.mjs").read_text(encoding="utf-8")
        self.assertIn("same_address_vectors.json", js)
        self.assertIn("static/js/settings/integrations.js", js)
        self.assertIn("function sameAddress(", js)
        self.assertIn("process.exit(failed ? 1 : 0)", js)
        src = (TESTS.parent / "static" / "js" / "settings" / "integrations.js").read_text(encoding="utf-8")
        self.assertIn("  // Python's str.strip() whitespace", src)     # where the check starts reading


if __name__ == "__main__":
    unittest.main()
