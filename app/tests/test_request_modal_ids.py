"""
The poster modal on the requests page sends the id it was given.

Book ids are strings such as "gr:3634639". requestFromModal used to parseInt
the poster's data-media-id, so a book or audiobook requested from the Trending
Books or Trending Audiobooks modal posted bookId "NaN" and failed. The modal now
passes the attribute through unchanged, as the search cards do, and the Seerr
route turns a film or show's "550" into the number it expects.

The page's script is the page module pages/requests.js (soft navigation, Task
12); the modal's button reaches requestFromModal through the page's click
listener (data-action), not an inline onclick.
"""
import re
import unittest

from app.tests.test_shell_contract import STATIC, live_matches, matching_brace

try:
    from pydantic import ValidationError
    from app.routers.integrations import RequestCreate, BookRequestCreate
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

REQUESTS = (STATIC / "js" / "pages" / "requests.js").read_text(encoding="utf-8")


def body_of(src: str, fn: str) -> str:
    m = re.search(rf"\bfunction {fn}\([^)]*\)\s*\{{", src)
    assert m, fn
    return src[m.end():matching_brace(src, m.end() - 1)]


class ModalRequestPassesTheIdThrough(unittest.TestCase):
    def setUp(self):
        self.modal = body_of(REQUESTS, "requestFromModal")

    def test_the_id_is_not_made_a_number(self):
        for cast in (r"\bparseInt\(", r"\bparseFloat\(", r"\bNumber\(", r"\+\s*buttonEl"):
            self.assertFalse(live_matches(self.modal, cast), cast)

    def test_the_attribute_goes_straight_to_request_media(self):
        self.assertTrue(live_matches(
            self.modal, r"\bmediaId\s*=\s*buttonEl\.getAttribute\(\s*'data-media-id'\s*\)\s*;"))
        self.assertTrue(live_matches(
            self.modal, r"\brequestMedia\(\s*mediaType\s*,\s*mediaId\s*,\s*false\s*,\s*buttonEl\s*\)"))

    def test_the_modal_button_reaches_request_from_modal(self):
        # Built with the id in data-media-id and handed, as itself, to
        # requestFromModal by the page's one click listener.
        open_modal = body_of(REQUESTS, "openMediaModal")
        self.assertIn('''<button type="button" id="modalRequestBtn" data-action="request-from-modal" ''', open_modal)
        self.assertIn('''data-media-id="' + escapeHtml(String(item.id)) + '" ''', open_modal)
        self.assertTrue(live_matches(REQUESTS, r"case 'request-from-modal': requestFromModal\(el\); break;"))

    def test_request_media_sends_book_ids_as_strings(self):
        media = body_of(REQUESTS, "requestMedia")
        self.assertTrue(live_matches(media, r"\bbookId:\s*String\(\s*mediaId\s*\)"))


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class RoutesAcceptTheModalIds(unittest.TestCase):
    def test_seerr_turns_a_string_id_into_a_number(self):
        for kind, raw in (("movie", "550"), ("tv", "1399")):
            body = RequestCreate(mediaType=kind, mediaId=raw)
            self.assertEqual(body.mediaId, int(raw))

    def test_seerr_still_refuses_a_non_numeric_id(self):
        with self.assertRaises(ValidationError):
            RequestCreate(mediaType="movie", mediaId="gr:3634639")

    def test_chaptarr_keeps_the_book_id_as_given(self):
        self.assertEqual(BookRequestCreate(bookId="gr:3634639").bookId, "gr:3634639")


if __name__ == "__main__":
    unittest.main()
