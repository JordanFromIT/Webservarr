"""
Radarr movie calendar integration.
Fetches upcoming movies from Radarr's calendar API.
"""

import logging
from datetime import datetime, timedelta, timezone
import httpx
from app.database import SessionLocal
from app.models import Setting

logger = logging.getLogger(__name__)

TIMEOUT = 5.0

# What counts as a recent addition, for the "added this month" figure.
RECENT_DAYS = 30


def _get_config() -> dict:
    """Read Radarr config from settings table (short-lived session)."""
    db = SessionLocal()
    try:
        url_setting = db.query(Setting).filter(Setting.key == "integration.radarr.url").first()
        key_setting = db.query(Setting).filter(Setting.key == "integration.radarr.api_key").first()
        return {
            "url": url_setting.value.rstrip("/") if url_setting else None,
            "api_key": key_setting.value if key_setting else None,
        }
    finally:
        db.close()


async def library_summary() -> dict:
    """
    Shape of the film library: {movies, tracked, bytes, added_recently}.

    `movies` counts films actually on disk. `tracked` includes ones Radarr is
    monitoring but has not found yet, which are wanted rather than owned.
    """
    config = _get_config()
    if not config["url"] or not config["api_key"]:
        return {"movies": 0, "tracked": 0, "bytes": 0, "added_recently": 0, "in_progress": 0, "unreleased": 0}

    try:
        async with httpx.AsyncClient(timeout=20.0, verify=False) as client:
            resp = await client.get(
                f"{config['url']}/api/v3/movie",
                headers={"X-Api-Key": config["api_key"]},
            )
    except httpx.RequestError as exc:
        logger.warning("Radarr movie list failed: %s", exc)
        return {"movies": 0, "tracked": 0}

    if resp.status_code != 200:
        logger.warning("Radarr movie list returned HTTP %d", resp.status_code)
        return {"movies": 0, "tracked": 0}

    try:
        movies = resp.json()
    except ValueError:
        return {"movies": 0, "tracked": 0}

    if not isinstance(movies, list):
        return {"movies": 0, "tracked": 0}

    cutoff = (datetime.now(timezone.utc) - timedelta(days=RECENT_DAYS)).isoformat()

    # Wanted films split by whether the film exists yet. Radarr's status is the
    # authority: "released" means it is out and simply has not been found, while
    # "announced" and "inCinemas" mean no home release exists to find. Lumping
    # them together would report two dozen films as stuck when nothing is wrong
    # with them.
    wanted = [m for m in movies if m.get("monitored") and not m.get("hasFile")]
    in_progress = sum(1 for m in wanted if m.get("status") == "released")
    unreleased = sum(1 for m in wanted if m.get("status") in ("announced", "inCinemas", "tba"))

    return {
        "movies": sum(1 for m in movies if m.get("hasFile")),
        "tracked": len(movies),
        "bytes": sum(m.get("sizeOnDisk") or 0 for m in movies),
        "added_recently": sum(1 for m in movies if (m.get("added") or "") > cutoff),
        "in_progress": in_progress,
        "unreleased": unreleased,
    }


async def get_calendar(days: int = 14, start: str = "") -> list:
    """
    Fetch upcoming movies from Radarr's calendar.
    Returns list of dicts with movie title, release date, and type.
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
