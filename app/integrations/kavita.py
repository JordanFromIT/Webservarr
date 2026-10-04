"""
Kavita, read by the server for the Books catalog.

app/routers/kavita_proxy.py is the browser's way into Kavita and acts as the
signed-in person. This is the server's own read of the whole library, made
with one API key (setting integration.kavita.api_key): it exchanges the key
for a short-lived token, lists every series and reads each one's metadata for
its author and summary.

The key travels in the query string of the one exchange call (Kavita's
Plugin/authenticate takes it nowhere else), so no error raised here carries a
URL or an httpx message: every failure is a KavitaUnavailable with a fixed
sentence, safe to store and to show on the Settings page.
"""

import asyncio
import html
import json
import logging
import re
from datetime import datetime
from typing import Optional

import httpx

from app.integrations import config as integration_config

logger = logging.getLogger(__name__)

URL_KEY = "integration.kavita.url"
API_KEY = "integration.kavita.api_key"

TIMEOUT = 20.0
PAGE_SIZE = 200
MAX_PAGES = 500              # a runaway Pagination header can't keep the loop going
METADATA_CONCURRENCY = 5     # Kavita is one small server across the tunnel
PLUGIN_NAME = "WebServarr"

_TAGS = re.compile(r"<[^>]*>")
_BREAKS = re.compile(r"<\s*(?:br\s*/?|/p)\s*>", re.IGNORECASE)
_BLANK_RUNS = re.compile(r"[ \t\r\f\v]*\n[ \t\r\f\v\n]*")


class KavitaUnavailable(Exception):
    """Kavita is not set up, did not answer, or refused the key. The message
    is fixed text: it names no address and no key."""


def _config() -> tuple:
    values = integration_config.read((URL_KEY, API_KEY))
    base = integration_config.base_url("kavita", values)
    key = values.get(API_KEY) or ""
    if not base:
        raise KavitaUnavailable("Kavita is not set up")
    if not key:
        raise KavitaUnavailable("Add the Kavita API key")
    if integration_config.padded(base) or integration_config.padded(key):
        raise KavitaUnavailable("The Kavita address or API key starts or ends with a space")
    return base, key


def plain_text(value) -> str:
    """Kavita's summary is HTML; the catalog keeps it as plain text."""
    text = _BREAKS.sub("\n", str(value or ""))
    text = html.unescape(_TAGS.sub("", text))
    return _BLANK_RUNS.sub("\n", text).strip()


def _when(value) -> Optional[datetime]:
    """Kavita's naive timestamp; it is its server's own clock and, for the
    catalog's "recently added" order, close enough to UTC."""
    try:
        return datetime.fromisoformat(str(value)).replace(tzinfo=None)
    except ValueError:
        return None


async def _get_json(client: httpx.AsyncClient, method: str, url: str, headers: dict, **kwargs):
    try:
        response = await client.request(method, url, headers=headers, **kwargs)
    except httpx.HTTPError as exc:
        raise KavitaUnavailable("Kavita did not answer") from exc
    if response.status_code in (401, 403):
        raise KavitaUnavailable("Kavita refused the API key")
    if response.status_code != 200:
        raise KavitaUnavailable(f"Kavita answered HTTP {response.status_code}")
    try:
        return response.json(), response.headers
    except ValueError as exc:
        raise KavitaUnavailable("Kavita's answer could not be read") from exc


async def _token(client: httpx.AsyncClient, base: str, key: str) -> str:
    try:
        response = await client.post(f"{base}/api/Plugin/authenticate",
                                     params={"apiKey": key, "pluginName": PLUGIN_NAME})
    except httpx.HTTPError as exc:
        raise KavitaUnavailable("Kavita did not answer") from exc
    if response.status_code != 200:
        raise KavitaUnavailable("Kavita refused the API key")
    try:
        token = (response.json() or {}).get("token")
    except (ValueError, AttributeError) as exc:
        raise KavitaUnavailable("Kavita's answer could not be read") from exc
    if not token:
        raise KavitaUnavailable("Kavita refused the API key")
    return token


async def _all_series(client: httpx.AsyncClient, base: str, headers: dict) -> list:
    body = {"statements": [], "combination": 1, "limitTo": 0,
            "sortOptions": {"sortField": 1, "isAscending": True}}
    series = []
    for page in range(1, MAX_PAGES + 1):
        items, answer = await _get_json(client, "POST", f"{base}/api/Series/all-v2", headers,
                                        params={"PageNumber": page, "PageSize": PAGE_SIZE}, json=body)
        if not isinstance(items, list):
            raise KavitaUnavailable("Kavita's answer could not be read")
        series.extend(s for s in items if isinstance(s, dict) and isinstance(s.get("id"), int))
        try:
            pages = int(json.loads(answer.get("pagination") or "{}").get("totalPages") or 1)
        except (ValueError, TypeError, AttributeError):
            pages = 1
        if page >= pages or not items:
            break
    return series


async def list_series() -> list:
    """Every series in every Kavita library:
    [{id, library_id, title, sort_title, author, description, added_at}].

    `author` is the series' first writer ("" when it has none), `description`
    its summary as plain text and `added_at` a naive datetime (None when
    Kavita gives none). Raises KavitaUnavailable."""
    base, key = _config()
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False) as client:
        headers = {"Authorization": f"Bearer {await _token(client, base, key)}"}
        series = await _all_series(client, base, headers)
        gate = asyncio.Semaphore(METADATA_CONCURRENCY)

        async def metadata(item: dict) -> dict:
            async with gate:
                data, _ = await _get_json(client, "GET", f"{base}/api/Series/metadata", headers,
                                          params={"seriesId": item["id"]})
            return data if isinstance(data, dict) else {}

        metas = await asyncio.gather(*(metadata(s) for s in series), return_exceptions=True)
    for meta in metas:
        if isinstance(meta, BaseException):
            raise meta
    books = []
    for item, meta in zip(series, metas):
        writers = [w.get("name") for w in (meta.get("writers") or []) if isinstance(w, dict) and w.get("name")]
        title = str(item.get("name") or "").strip()
        books.append({
            "id": item["id"],
            "library_id": item.get("libraryId") if isinstance(item.get("libraryId"), int) else None,
            "title": title,
            "sort_title": str(item.get("sortName") or "").strip() or title,
            "author": str(writers[0]).strip() if writers else "",
            "description": plain_text(meta.get("summary")),
            "added_at": _when(item.get("created")),
        })
    return books
