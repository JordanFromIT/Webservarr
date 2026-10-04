"""
R180: a discover card on the requests page says where its title stands in
words, beside the type badge, instead of a coloured dot on the poster.

The words come from the shared request vocabulary (WS.requestStatus), a title
nobody asked for gets no label at all, and the label never changes the card's
height, so the skeleton still equals the real card. Books carry a status only
from Chaptarr's per-format library rows (see chaptarr._format_status).
"""
import asyncio
import re
import unittest
from unittest import mock

from app.tests.test_shell_contract import STATIC, live_matches, matching_brace

try:
    from app.integrations import chaptarr
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

# The page's script is the page module since soft navigation (Task 12); the
# discover rows' skeleton cards are markup in the page.
REQUESTS = (STATIC / "js" / "pages" / "requests.js").read_text(encoding="utf-8")
REQUESTS_HTML = (STATIC / "requests.html").read_text(encoding="utf-8")


def body_of(src: str, fn: str) -> str:
    m = re.search(rf"\bfunction {fn}\([^)]*\)\s*\{{", src)
    assert m, fn
    return src[m.end():matching_brace(src, m.end() - 1)]


class DiscoverCardStatusLabel(unittest.TestCase):
    """Audit M3/M8: the shelf card is the Books card, and where a title stands
    is a mark on its cover, where Books marks a new book (top left), in
    words from the shared vocabulary."""

    def setUp(self):
        self.card = body_of(REQUESTS, "buildDiscoverCard")
        self.label = body_of(REQUESTS, "statusMark")

    def test_the_mark_sits_on_the_cover(self):
        self.assertTrue(live_matches(self.card, r"\bstatusHtml\s*=\s*statusMark\(\s*status\s*\)"))
        self.assertTrue(live_matches(self.card, r"coverMarkup\(\s*item\.poster_url \|\| '',\s*mediaType,\s*statusHtml,\s*index >= 8\s*\)"))
        self.assertIn("absolute left-2 top-2 inline-flex h-6 max-w-[calc(100%-1rem)]", self.label)
        self.assertIn("'<span class=\"truncate\">' + escapeHtml(shown)", self.label)

    def test_on_the_server_takes_the_accent_and_the_rest_are_quiet(self):
        self.assertIn("(known.tone === 'ready' ? 'bg-primary text-bright' : 'bg-background-dark/80 text-frosted-blue')", self.label)

    def test_words_are_the_shared_vocabulary(self):
        self.assertTrue(live_matches(self.label, r"\bWS\.requestStatus\(\s*status\s*\)"))
        self.assertTrue(live_matches(body_of(REQUESTS, "statusWord"), r"\bWS\.requestStatus\(\s*status\s*\)\.label"))

    def test_no_status_means_no_mark(self):
        # Never requested, or Seerr's "unknown": nothing, not the word Unknown.
        self.assertTrue(live_matches(
            self.label,
            r"if\s*\(\s*!status\s*\|\|\s*status\s*===\s*'unknown'\s*\)\s*return\s*''\s*;"))
        self.assertNotIn("Unknown", self.label)
        # And "unknown" can be requested from a search card and the dialog.
        self.assertTrue(live_matches(body_of(REQUESTS, "knownStatus"), r"return s === 'unknown' \? null : s;"))
        self.assertIn("var status = knownStatus(item.media_status);", body_of(REQUESTS, "buildSearchCard"))

    def test_partly_available_is_short_on_the_card_only(self):
        # The full words stay in the mark's title and everywhere else.
        self.assertRegex(REQUESTS, r"const DISCOVER_SHORT_LABELS = \{ partially_available: 'Partly here' \};")
        self.assertTrue(live_matches(
            self.label, r"\bshown\s*=\s*DISCOVER_SHORT_LABELS\[status\]\s*\|\|\s*statusWord\(status\)"))
        self.assertRegex(self.label, r"title=\"' \+ escapeHtml\(statusWord\(status\)\) \+")

    def test_the_skeleton_card_is_the_cards_box(self):
        skel = re.search(r'<div class="w-36 shrink-0" aria-hidden="true">[^\n]*', REQUESTS_HTML).group(0)
        self.assertIn("aspect-[2/3] rounded-xl", skel)
        self.assertIn("min-h-[2.75em]", skel)
        self.assertIn("text-label leading-5 min-h-5", skel)
        self.assertIn("'flex w-36 shrink-0 flex-col", self.card.replace('"', "'").replace("class='", "'"))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class BookFormatStatus(unittest.TestCase):
    """What Chaptarr's search hands back for a work in the library: empty
    top-level fields, and one list of library rows per format."""

    def _result(self, ebook, audiobook):
        return {
            "foreignId": "hc:1",
            "existingLocalId": "7",       # tracked; says nothing about wanted
            "book": {
                "title": "A Book",
                "foreignBookId": "hc:1",
                "localBookId": 0,
                "hasFiles": False,
                "monitored": False,
                "author": {"authorName": "An Author"},
                "localEbookBooks": ebook,
                "localAudiobookBooks": audiobook,
            },
        }

    def _normalise(self, result, fmt="ebook"):
        with mock.patch.object(chaptarr, "_cache_book", mock.AsyncMock()):
            return asyncio.run(chaptarr._normalise(result, fmt))

    def test_rows_map_to_the_seerr_words(self):
        self.assertEqual(chaptarr._format_status([{"monitored": True, "hasFiles": True}]), "available")
        self.assertEqual(chaptarr._format_status([{"monitored": True, "hasFiles": False}]), "processing")
        # An author import: tracked, never wanted, not here.
        self.assertIsNone(chaptarr._format_status([{"monitored": False, "hasFiles": False}]))
        self.assertIsNone(chaptarr._format_status([]))
        self.assertIsNone(chaptarr._format_status(None))
        self.assertIsNone(chaptarr._format_status(["junk", 3]))
        # Any row with files wins: a spare unmonitored copy does not hide it.
        self.assertEqual(chaptarr._format_status([{"monitored": False, "hasFiles": False},
                                                  {"monitored": True, "hasFiles": True}]), "available")

    def test_each_format_reads_its_own_rows(self):
        result = self._result([{"monitored": True, "hasFiles": False}],
                              [{"monitored": True, "hasFiles": True}])
        self.assertEqual(self._normalise(result, "ebook")["media_status"], "processing")
        self.assertEqual(self._normalise(result, "audiobook")["media_status"], "available")

    def test_tracked_but_unwanted_is_not_available(self):
        # existingLocalId alone used to read as "available".
        result = self._result([{"monitored": False, "hasFiles": False}], [])
        self.assertIsNone(self._normalise(result)["media_status"])
        self.assertIsNone(self._normalise(self._result(None, None))["media_status"])

    def test_the_audiobook_shelf_asks_for_audiobook_status(self):
        from pathlib import Path
        src = (Path(chaptarr.__file__).resolve().parents[1] / "routers" / "integrations.py").read_text()
        m = re.search(r"async def build_audiobooks_shelf\(\).*?\n(?=async def |@router)", src, re.S)
        self.assertIn('chaptarr.resolve_trending(ranked, fmt="audiobook")', m.group(0))


if __name__ == "__main__":
    unittest.main()
