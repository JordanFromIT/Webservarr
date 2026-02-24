"""
Radarr movie calendar integration.
Fetches upcoming movies from Radarr's calendar API.
"""

import logging
from datetime import datetime, timedelta
import httpx
from sqlalchemy.orm import Session
from app.models import Setting

logger = logging.getLogger(__name__)

TIMEOUT = 5.0


def _get_config(db: Session) -> dict:
    """Read Radarr config from settings table."""
    url_setting = db.query(Setting).filter(Setting.key == "integration.radarr.url").first()
    key_setting = db.query(Setting).filter(Setting.key == "integration.radarr.api_key").first()
    return {
        "url": url_setting.value.rstrip("/") if url_setting else None,
        "api_key": key_setting.value if key_setting else None,
    }


async def get_calendar(db: Session, days: int = 14, start: str = "") -> list:
    """
    Fetch upcoming movies from Radarr's calendar.
    Returns list of dicts with movie title, release date, and type.
    """
    config = _get_config(db)
    if not config["url"] or not config["api_key"]:
        return []

    start_date = start if start else datetime.utcnow().strftime("%Y-%m-%d")
    end_date = (datetime.strptime(start_date, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{config['url']}/api/v3/calendar",
                params={"start": start_date, "end": end_date},
                headers={"X-Api-Key": config["api_key"]},
            )
            if resp.status_code != 200:
                logger.warning("Radarr calendar returned HTTP %d", resp.status_code)
                return []

            movies = resp.json()
            results = []

            for movie in movies:
                # Get poster image if available
                poster_url = ""
                for image in movie.get("images", []):
                    if image.get("coverType") == "poster" and image.get("remoteUrl"):
                        poster_url = image["remoteUrl"]
                        break

                # Determine release type and date
                # Radarr calendar entries have different release date types
                air_date = movie.get("digitalRelease") or movie.get("physicalRelease") or movie.get("inCinemas", "")

                release_type = "digital"
                if movie.get("inCinemas") and not movie.get("digitalRelease"):
                    release_type = "theatrical"
                elif movie.get("physicalRelease"):
                    release_type = "physical"

                results.append({
                    "title": movie.get("title", "Unknown Movie"),
                    "episode_title": "",
                    "episode_code": release_type.capitalize() + " Release",
                    "air_date": air_date,
                    "media_type": "movie",
                    "poster_url": poster_url,
                    "overview": movie.get("overview", ""),
                    "has_file": movie.get("hasFile", False),
                })

            return results

    except httpx.TimeoutException:
        logger.warning("Radarr connection timed out")
        return []
    except httpx.ConnectError:
        logger.warning("Could not connect to Radarr at %s", config["url"])
        return []
    except Exception as e:
        logger.error("Radarr integration error: %s", str(e))
        return []
