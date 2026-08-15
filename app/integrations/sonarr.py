"""
Sonarr TV show integration.

Two jobs: the upcoming-episodes calendar, and exact episode counts for the
requests page.
"""

import logging
import time
from datetime import datetime, timedelta
import httpx
from app.database import SessionLocal
from app.models import Setting

logger = logging.getLogger(__name__)

TIMEOUT = 5.0

# The whole series list is one request but a large response, so it is fetched
# once and reused. Five minutes is well inside how often a library changes.
_COUNTS_TTL = 300.0
_SERIES_TIMEOUT = 20.0
_counts_cache: dict = {}
_counts_fetched_at = 0.0


def _get_config() -> dict:
    """Read Sonarr config from settings table (short-lived session)."""
    db = SessionLocal()
    try:
        url_setting = db.query(Setting).filter(Setting.key == "integration.sonarr.url").first()
        key_setting = db.query(Setting).filter(Setting.key == "integration.sonarr.api_key").first()
        return {
            "url": url_setting.value.rstrip("/") if url_setting else None,
            "api_key": key_setting.value if key_setting else None,
        }
    finally:
        db.close()


async def episode_counts() -> dict:
    """
    Map TMDB id -> (episodes_on_disk, episodes_total) for every tracked series.

    Sonarr is the only component that knows this exactly: it tracks a file per
    episode, where Seerr only records availability per *season* and reports a
    half-stocked season as nothing at all (it puts The Land Before Time at 0 of
    26; Sonarr has 23 of them).

    Season 0 is excluded. It is TMDB's bucket for specials, webisodes and
    deleted scenes - 106 entries for The Office against 201 real episodes - and
    counting it makes a complete library look badly incomplete.

    Returns {} when Sonarr is unconfigured or unreachable, which simply means
    no counts are shown.
    """
    global _counts_fetched_at

    if _counts_cache and (time.monotonic() - _counts_fetched_at) < _COUNTS_TTL:
        return _counts_cache

    config = _get_config()
    if not config["url"] or not config["api_key"]:
        return {}

    try:
        async with httpx.AsyncClient(timeout=_SERIES_TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{config['url']}/api/v3/series",
                headers={"X-Api-Key": config["api_key"]},
            )
    except httpx.RequestError as exc:
        logger.warning("Sonarr series fetch failed: %s", exc)
        return {}

    if resp.status_code != 200:
        logger.warning("Sonarr series returned HTTP %d", resp.status_code)
        return {}

    try:
        series_list = resp.json()
    except ValueError:
        return {}

    counts = {}
    for series in series_list if isinstance(series_list, list) else []:
        tmdb_id = series.get("tmdbId")
        if not tmdb_id:
            continue

        have = total = 0
        for season in series.get("seasons") or []:
            if not season.get("seasonNumber"):  # skip specials
                continue
            stats = season.get("statistics") or {}
            have += stats.get("episodeFileCount") or 0
            total += stats.get("totalEpisodeCount") or 0

        if total:
            counts[tmdb_id] = (have, total)

    _counts_cache.clear()
    _counts_cache.update(counts)
    _counts_fetched_at = time.monotonic()
    return _counts_cache


async def get_calendar(days: int = 14, start: str = "") -> list:
    """
    Fetch upcoming episodes from Sonarr's calendar.
    Returns list of dicts with series title, episode info, and air date.
    """
    config = _get_config()
    if not config["url"] or not config["api_key"]:
        return []

    start_date = start if start else datetime.utcnow().strftime("%Y-%m-%d")
    end_date = (datetime.strptime(start_date, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{config['url']}/api/v3/calendar",
                params={"start": start_date, "end": end_date, "includeSeries": "true"},
                headers={"X-Api-Key": config["api_key"]},
            )
            if resp.status_code != 200:
                logger.warning("Sonarr calendar returned HTTP %d", resp.status_code)
                return []

            episodes = resp.json()
            results = []

            for ep in episodes:
                series = ep.get("series", {})
                season_num = ep.get("seasonNumber", 0)
                episode_num = ep.get("episodeNumber", 0)
                episode_code = f"S{season_num:02d}E{episode_num:02d}"

                # Get poster image if available
                poster_url = ""
                for image in series.get("images", []):
                    if image.get("coverType") == "poster" and image.get("remoteUrl"):
                        poster_url = image["remoteUrl"]
                        break

                results.append({
                    "title": series.get("title", "Unknown Series"),
                    "episode_title": ep.get("title", ""),
                    "episode_code": episode_code,
                    "air_date": ep.get("airDateUtc", ""),
                    "media_type": "tv",
                    "poster_url": poster_url,
                    "overview": ep.get("overview", ""),
                    "has_file": ep.get("hasFile", False),
                })

            return results

    except httpx.TimeoutException:
        logger.warning("Sonarr connection timed out")
        return []
    except httpx.ConnectError:
        logger.warning("Could not connect to Sonarr at %s", config["url"])
        return []
    except Exception as e:
        logger.error("Sonarr integration error: %s", str(e))
        return []
