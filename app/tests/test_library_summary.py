"""
The eBooks book sheet shows Kavita's series summary as text only.

The summary is upstream HTML from Kavita's /api/Series/metadata, which the
proxy does not clean (only book pages are bleached). It used to be parsed by
setting innerHTML on a detached <div>: that still loads images, so a summary
holding <img src=x onerror=...> ran script in the app's origin for anyone
who opened the book. It is now parsed into an inert DOMParser document (no
scripts, no image loads) and only the text is kept, written with textContent.
"""
import re
import unittest

from app.tests.test_kavita_connect import inline_js
from app.tests.test_shell_contract import STATIC, js_code_only, matching_brace

# The page's own inline scripts: markup text would confuse the JS scanner.
LIBRARY = inline_js((STATIC / "library.html").read_text(encoding="utf-8"))


def function_body(src: str, name: str) -> str:
    """The body of `function name(...) {...}` as code (comments removed, strings blanked)."""
    code = js_code_only(src)
    m = re.search(rf"\bfunction {name}\([^)]*\)\s*\{{", code)
    assert m, f"no function {name}()"
    return code[m.end() - 1:matching_brace(code, m.end() - 1) + 1]


class SeriesSummary(unittest.TestCase):
    def test_the_summary_is_parsed_inertly(self):
        body = function_body(LIBRARY, "stripHtml")
        self.assertRegex(body, r"new DOMParser\(\)\.parseFromString\(")
        self.assertIn("'text/html'", LIBRARY[LIBRARY.index("function stripHtml("):][:600])
        self.assertRegex(body, r"\.body\.textContent")
        for live in (r"\.innerHTML\b", r"\.outerHTML\b", r"insertAdjacentHTML", r"createElement\(",
                     r"createContextualFragment", r"document\.write"):
            self.assertNotRegex(body, live)

    def test_the_summary_is_written_as_text(self):
        code = js_code_only(LIBRARY)
        uses = [m.start() for m in re.finditer(r"\bstripHtml\(\s*md\.summary\s*\)", code)]
        self.assertTrue(uses, "the summary no longer goes through stripHtml")
        self.assertRegex(LIBRARY, r"bdEl\('bdSummary'\)\.textContent\s*=\s*summary\b")
        self.assertNotRegex(LIBRARY, r"bdEl\('bdSummary'\)\.innerHTML")


if __name__ == "__main__":
    unittest.main()
