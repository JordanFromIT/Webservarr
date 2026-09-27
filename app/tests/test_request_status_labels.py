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

REQUESTS = (STATIC / "requests.html").read_text(encoding="utf-8")


def body_of(src: str, fn: str) -> str:
    m = re.search(rf"\bfunction {fn}\([^)]*\)\s*\{{", src)
    assert m, fn
    return src[m.end():matching_brace(src, m.end() - 1)]


class DiscoverCardStatusLabel(unittest.TestCase):
    def setUp(self):
        self.card = body_of(REQUESTS, "buildDiscoverCard")
        self.label = body_of(REQUESTS, "discoverStatusLabel")

    def test_the_poster_dot_is_gone(self):
        for gone in ("dotHtml", "dotColor", "rounded-full", "top-2 left-2", "bg-status-ok", "bg-status-warn"):
            self.assertNotIn(gone, self.card, gone)

    def test_the_label_sits_in_the_badge_row_after_the_type(self):
        row = re.search(r"'<div class=\"flex items-center gap-1 min-w-0 mb-1\">' \+(.*?)'</div>'", self.card, re.S)
        self.assertIsNotNone(row, "the badge row")
        inner = row.group(1)
        badge = inner.index("typeBadge + '</span>'")
        self.assertLess(badge, inner.index("statusHtml"), "the status follows the type badge")
        self.assertIn("shrink-0 text-[8px] font-bold px-1 py-0.5 rounded", inner)
        self.assertTrue(live_matches(self.card, r"\bstatusHtml\s*=\s*discoverStatusLabel\(\s*status\s*\)"))

    def test_the_label_matches_the_badge_and_gives_way(self):
        # Same type size and box as the badge, so the row keeps its height; it
        # truncates rather than wrapping or pushing the type out.
        self.assertIn("min-w-0 truncate text-[8px] font-bold px-1 py-0.5 rounded", self.label)
        self.assertIn("flex items-center gap-1 min-w-0 mb-1", self.card)
        self.assertNotIn("flex-wrap", self.card)

    def test_words_and_tones_are_the_shared_vocabulary(self):
        self.assertTrue(live_matches(self.label, r"\bWS\.requestStatus\(\s*status\s*\)"))
        self.assertTrue(live_matches(self.label, r"\bSTATUS_TONE_CLASSES\["))
        self.assertTrue(live_matches(self.label, r"\bescapeHtml\(\s*known\.label\s*\)"))

    def test_no_status_means_no_label(self):
        # Never requested, or Seerr's "unknown": nothing, not the word Unknown.
        self.assertTrue(live_matches(
            self.label,
            r"if\s*\(\s*!status\s*\|\|\s*status\s*===\s*'unknown'\s*\)\s*return\s*''\s*;"))
        self.assertNotIn("Unknown", self.label)

    def test_the_skeleton_card_carries_the_same_row(self):
        skel = body_of(REQUESTS, "buildDiscoverSkeletons")
        for token in ("flex items-center gap-1 min-w-0 mb-1",
                      "shrink-0 text-[8px] font-bold px-1 py-0.5 rounded",
                      "text-[11px] font-medium leading-tight truncate"):
            self.assertIn(token, skel, token)
            self.assertIn(token, self.card, token)


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
