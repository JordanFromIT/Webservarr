"""
Sonarr TV show integration.

Two jobs: the upcoming-episodes calendar, and exact episode counts for the
requests page.
"""

import logging
import time
from datetime import datetime, timedelta, timezone
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

# Gathered on the same pass as the episode counts, so the summary does not need
# a second walk of every series.
_last_series_bytes = 0
_last_series_added = 0
_last_seasons_total = 0
_last_seasons_complete = 0

# What counts as a recent addition, for the "added this month" figure.
RECENT_DAYS = 30


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

    The denominator is `episodeCount`, not `totalEpisodeCount`. The latter
    counts every episode the series will ever have, including ones that have
    not aired and seasons deliberately left unmonitored - so Ted Lasso reads 36
    of 44 while actually being complete, and Law & Order: SVU reads 22 of 596
    when 22 is every episode being tracked. `episodeCount` is Sonarr's
    monitored-and-aired figure, which is the only denominator a reader would
    recognise as "how much of this show do we have".

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

    global _last_series_bytes, _last_series_added
    global _last_seasons_total, _last_seasons_complete
    seasons_total = seasons_complete = 0
    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=RECENT_DAYS)
    ).isoformat()
    total_bytes = 0
    added_recently = 0

    counts = {}
    for series in series_list if isinstance(series_list, list) else []:
        total_bytes += (series.get("statistics") or {}).get("sizeOnDisk") or 0
        if (series.get("added") or "") > cutoff:
            added_recently += 1

        tmdb_id = series.get("tmdbId")
        if not tmdb_id:
            continue

        have = total = 0
        for season in series.get("seasons") or []:
            if not season.get("seasonNumber"):  # skip specials
                continue
            stats = season.get("statistics") or {}
            season_have = stats.get("episodeFileCount") or 0
            season_want = stats.get("episodeCount") or 0
            have += season_have
            total += season_want
            # Season-level completeness is stricter than show-level and worth
            # reporting separately: a show is only complete when every one of
            # its seasons is, so the two answer different questions.
            if season_want > 0:
                seasons_total += 1
                if season_have >= season_want:
                    seasons_complete += 1

        if total:
            counts[tmdb_id] = (have, total)

    _last_series_bytes = total_bytes
    _last_series_added = added_recently
    _last_seasons_total = seasons_total
    _last_seasons_complete = seasons_complete
    _counts_cache.clear()
    _counts_cache.update(counts)
    _counts_fetched_at = time.monotonic()
    return _counts_cache


async def library_summary() -> dict:
    """
    Shape of the TV library.

    Only shows with at least one episode on disk are counted. A show that was
    added but never acquired says nothing about how the library is kept, and
    including them made a well-maintained library look neglected.

    `percent` is the share of shows that are complete - 506 of 564 - rather
    than a mean of per-show percentages. Both are defensible, but only one can
    be checked: "90% of shows are complete" is a claim about a number the rail
    prints right next to it, where a mean-of-means is a statistic a reader has
    to take on trust, which is exactly why the old 98% did not ring true.
    """
    counts = await episode_counts()
    started = {k: v for k, v in counts.items() if v[0] > 0}
    empty = {
        "shows": 0, "episodes": 0, "episodes_total": 0, "complete_shows": 0,
        "missing_episodes": 0, "percent": 0, "bytes": 0, "added_recently": 0,
        "seasons": 0, "complete_seasons": 0, "in_progress": 0,
    }
    if not started:
        return empty

    episodes = sum(have for have, _ in started.values())
    total = sum(want for _, want in started.values())
    complete = sum(1 for have, want in started.values() if have >= want)

    return {
        "shows": len(started),
        "episodes": episodes,
        "episodes_total": total,
        "complete_shows": complete,
        "missing_episodes": total - episodes,
        # Share of shows that are complete, which is a fact a reader can check
        # rather than a statistic they have to take on trust.
        "percent": round(100 * complete / len(started)),
        # Shows with aired episodes still missing - the ones actually being
        # chased, as distinct from shows simply waiting on a broadcast.
        "in_progress": len(started) - complete,
        "seasons": _last_seasons_total,
        "complete_seasons": _last_seasons_complete,
        "bytes": _last_series_bytes,
        "added_recently": _last_series_added,
    }


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
