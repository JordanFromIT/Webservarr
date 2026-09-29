"""
The stylesheet is compiled at development time and committed.

Tailwind only emits the classes it saw in the content files, so an HTML edit
shipped without a rebuild silently loses styling. The build stamps a hash of
every content file into the first line of app.css (scripts/stamp-css.mjs);
this test recomputes it with the same algorithm.

Run inside the container:
    python -m unittest discover -s /app/app/tests -t /app -v
"""
import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # repo root locally, /app in the container
STATIC = ROOT / "app" / "static"

# Mirrors GLOBS in scripts/stamp-css.mjs.
CONTENT_GLOBS = [
    ("app/static", "*.html"),
    ("app/static/partials", "*.html"),
    ("app/static/js", "*.js"),
    ("app/static/js/settings", "*.js"),
    ("app/static/js/pages", "*.js"),
    ("app/static/js/player", "*.js"),
    ("app", "pages.py"),
    ("app/static/css", "tailwind.src.css"),
]


def content_files(root: Path):
    files = set()
    for rel_dir, pattern in CONTENT_GLOBS:
        files.update(p for p in (root / rel_dir).glob(pattern) if p.is_file())
    return sorted(files, key=lambda p: p.relative_to(root).as_posix())


def css_content_hash(root: Path) -> str:
    h = hashlib.sha256()
    for p in content_files(root):
        h.update((p.relative_to(root).as_posix() + "\n").encode())
        h.update(p.read_bytes())
        h.update(b"\n")
    return h.hexdigest()[:16]


class CssBuildTests(unittest.TestCase):
    def test_app_css_is_current(self):
        css = STATIC / "css" / "app.css"
        self.assertTrue(css.exists(), "app/static/css/app.css missing - run `npm run build:css`")
        first = css.read_text(encoding="utf-8").splitlines()[0]
        m = re.match(r"/\* ws-css:([0-9a-f]{16}) \*/", first)
        self.assertIsNotNone(m, "app.css has no ws-css stamp - run `npm run build:css`")
        self.assertEqual(
            m.group(1), css_content_hash(ROOT),
            "app.css is stale - run `npm run build:css` and commit the result",
        )

    @unittest.skipUnless((ROOT / "tailwind.config.js").exists() and (ROOT / "scripts" / "stamp-css.mjs").exists(),
                         "the build files are not in the image (.dockerignore); CI's checkout has them")
    def test_the_stamp_scans_what_tailwind_scans(self):
        # A content path Tailwind reads but the stamp does not is a file whose
        # edits never make app.css stale in this test (a class added there is
        # silently missing). tailwind.src.css is the stamp's own extra: the input.
        config = (ROOT / "tailwind.config.js").read_text(encoding="utf-8")
        block = re.search(r"content:\s*\[(.*?)\]", config, re.S).group(1)
        tailwind = set()
        for path in re.findall(r"""["']\./([^"']+)["']""", block):
            folder, _, pattern = path.rpartition("/")
            tailwind.add((folder, pattern))
        ours = set(CONTENT_GLOBS) - {("app/static/css", "tailwind.src.css")}
        self.assertEqual(ours, tailwind, "CONTENT_GLOBS differs from tailwind.config.js content")
        stamp = (ROOT / "scripts" / "stamp-css.mjs").read_text(encoding="utf-8")
        stamp_dirs = set(re.findall(r'\[\s*"([^"]+)",\s*/', re.search(r"const GLOBS = \[(.*?)\n\];", stamp, re.S).group(1)))
        self.assertEqual(stamp_dirs, {d for d, _ in CONTENT_GLOBS}, "stamp-css.mjs GLOBS differs from CONTENT_GLOBS")

    def test_no_page_uses_the_play_cdn(self):
        for page in sorted(STATIC.glob("*.html")):
            html = page.read_text(encoding="utf-8")
            self.assertNotIn("cdn.tailwindcss.com", html, page.name)
            self.assertNotIn("tailwind.config", html, page.name)
            self.assertIn('href="/static/css/app.css?v=', html, page.name)


if __name__ == "__main__":
    unittest.main()
