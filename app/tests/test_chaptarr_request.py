"""
The Chaptarr add payload states the requested format.

Chaptarr picks the edition to monitor and grab from `mediaType` in the POST
body, not from the root folder, and every search result it returns carries
"audiobook" regardless of the actual book (see the chaptarr module docstring).
So an ebook request that posts the search result back unchanged creates an
audiobook row and the user never gets the book they asked for. These tests pin
the override.
"""
import asyncio
import json
import unittest
from unittest import mock

try:
    from app.integrations import chaptarr
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False


CONFIG = {
    "url": "http://chaptarr.invalid",
    "api_key": "k",
    "root_folder": "/ebooks",
    "audiobook_root_folder": "/audiobooks",
    "quality_profile_id": "1",
    "metadata_profile_id": "1",
    "audiobook_quality_profile_id": "2",
    "audiobook_metadata_profile_id": "2",
}

# What Chaptarr's own search hands back: always mediaType "audiobook".
SEARCH_RESULT = {
    "foreignBookId": "814330",
    "title": "Catch-22",
    "mediaType": "audiobook",
    "author": {"foreignAuthorId": "3167", "authorName": "Joseph Heller"},
}


class _Response:
    status_code = 201

    def json(self):
        return {}


class _FakeClient:
    """Captures the JSON body of the add POST."""

    def __init__(self, sent, **kwargs):
        self._sent = sent

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, params=None, headers=None):
        # The fresh lookup finds nothing, so the cached copy stands.
        return _Listing([])

    async def post(self, url, headers=None, json=None):
        self._sent.append(json)
        return _Response()


class _Listing:
    status_code = 200

    def __init__(self, body):
        self._body = body

    def json(self):
        return self._body


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class RequestBookMediaType(unittest.TestCase):
    def _request(self, fmt, config=None):
        sent = []
        with mock.patch.object(chaptarr, "_get_config", return_value=dict(config or CONFIG)), \
             mock.patch.object(chaptarr, "_get_cached_book",
                               mock.AsyncMock(return_value=dict(SEARCH_RESULT))), \
             mock.patch.object(chaptarr.httpx, "AsyncClient",
                               lambda **kw: _FakeClient(sent, **kw)):
            result = asyncio.run(chaptarr.request_book("814330", fmt=fmt))
        self.assertTrue(result["ok"], result)
        self.assertEqual(len(sent), 1)
        return sent[0]

    def test_ebook_request_posts_ebook_media_type(self):
        payload = self._request("ebook")
        self.assertEqual(payload["mediaType"], "ebook")
        self.assertEqual(payload["rootFolderPath"], "/ebooks")

    def test_audiobook_request_posts_audiobook_media_type(self):
        payload = self._request("audiobook")
        self.assertEqual(payload["mediaType"], "audiobook")
        self.assertEqual(payload["rootFolderPath"], "/audiobooks")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class RequestBookRootFolders(unittest.TestCase):
    """A new author's record needs both halves of the root folder pair (see
    _add_book). A server with one root folder sent an empty path for the
    other half, which is no root folder Chaptarr knows; the one folder now
    stands in for both. Two folders go through exactly as before."""

    _request = RequestBookMediaType._request

    def test_two_root_folders_go_through_unchanged(self):
        expected = dict(SEARCH_RESULT)
        expected.update({
            "monitored": True,
            "mediaType": "ebook",
            "rootFolderPath": "/ebooks",
            "author": {
                "foreignAuthorId": "3167", "authorName": "Joseph Heller", "monitored": True,
                "ebookQualityProfileId": 1, "ebookMetadataProfileId": 1, "ebookRootFolderPath": "/ebooks",
                "audiobookQualityProfileId": 2, "audiobookMetadataProfileId": 2,
                "audiobookRootFolderPath": "/audiobooks",
                "addOptions": {"monitor": "none", "searchForMissingBooks": False},
            },
            "addOptions": {"searchForNewBook": True},
        })
        # Key order too: the body Chaptarr receives is byte for byte the same.
        self.assertEqual(json.dumps(self._request("ebook")), json.dumps(expected))
        self.assertEqual(self._request("audiobook")["author"], expected["author"])

    def test_only_an_ebook_folder_stands_in_for_both(self):
        config = dict(CONFIG, audiobook_root_folder="")
        for fmt in ("ebook", "both"):
            with self.subTest(fmt=fmt):
                payload = self._request(fmt, config)
                self.assertEqual(payload["mediaType"], "ebook")
                self.assertEqual(payload["rootFolderPath"], "/ebooks")
                self.assertEqual((payload["author"]["ebookRootFolderPath"],
                                  payload["author"]["audiobookRootFolderPath"]), ("/ebooks", "/ebooks"))

    def test_only_an_audiobook_folder_stands_in_for_both(self):
        config = dict(CONFIG, root_folder="")
        for fmt in ("audiobook", "both"):
            with self.subTest(fmt=fmt):
                payload = self._request(fmt, config)
                self.assertEqual(payload["mediaType"], "audiobook")
                self.assertEqual(payload["rootFolderPath"], "/audiobooks")
                self.assertEqual((payload["author"]["ebookRootFolderPath"],
                                  payload["author"]["audiobookRootFolderPath"]), ("/audiobooks", "/audiobooks"))


if __name__ == "__main__":
    unittest.main()
