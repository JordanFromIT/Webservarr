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

    async def post(self, url, headers=None, json=None):
        self._sent.append(json)
        return _Response()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class RequestBookMediaType(unittest.TestCase):
    def _request(self, fmt):
        sent = []
        with mock.patch.object(chaptarr, "_get_config", return_value=dict(CONFIG)), \
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


if __name__ == "__main__":
    unittest.main()
