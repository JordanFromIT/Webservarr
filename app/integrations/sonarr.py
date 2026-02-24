"""
Sonarr TV show calendar integration.
Fetches upcoming episodes from Sonarr's calendar API.
"""

import logging
from datetime import datetime, timedelta
import httpx
from sqlalchemy.orm import Session
from app.models import Setting

logger = logging.getLogger(__name__)

TIMEOUT = 5.0


def _get_config(db: Session) -> dict:
    """Read Sonarr config from settings table."""
    url_setting = db.query(Setting).filter(Setting.key == "integration.sonarr.url").first()
    key_setting = db.query(Setting).filter(Setting.key == "integration.sonarr.api_key").first()
    return {
        "url": url_setting.value.rstrip("/") if url_setting else None,
        "api_key": key_setting.value if key_setting else None,
    }


async def get_calendar(db: Session, days: int = 14) -> list:
    """
    Fetch upcoming episodes from Sonarr's calendar.
    Returns list of dicts with series title, episode info, and air date.
    """
    config = _get_config(db)
    if not config["url"] or not config["api_key"]:
        return []

    start = datetime.utcnow().strftime("%Y-%m-%d")
    end = (datetime.utcnow() + timedelta(days=days)).strftime("%Y-%m-%d")

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{config['url']}/api/v3/calendar",
                params={"start": start, "end": end, "includeSeries": "true"},
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
