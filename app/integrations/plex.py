"""
Plex Media Server integration.
Fetches active streams for dashboard display.
"""

import logging
import xml.etree.ElementTree as ET
import httpx
from app.database import SessionLocal
from app.models import Setting

logger = logging.getLogger(__name__)

TIMEOUT = 10.0


def _get_config() -> dict:
    """Read Plex config from settings table (short-lived session)."""
    db = SessionLocal()
    try:
        url_setting = db.query(Setting).filter(Setting.key == "integration.plex.url").first()
        token_setting = db.query(Setting).filter(Setting.key == "integration.plex.token").first()
        return {
            "url": url_setting.value.rstrip("/") if url_setting else None,
            "token": token_setting.value if token_setting else None,
        }
    finally:
        db.close()


async def _get_best_media_quality(
    client: httpx.AsyncClient, config: dict, rating_key: str
) -> tuple:
    """
    Fetch library metadata to find the best available media quality.
    Returns (quality_label, height) e.g. ("4K", 1746).
    Sessions API only returns the selected version; this gets the best.
    """
    try:
        resp = await client.get(
            f"{config['url']}/library/metadata/{rating_key}",
            params={"X-Plex-Token": config["token"]},
        )
        if resp.status_code != 200:
            return "SD", 0
        lib_root = ET.fromstring(resp.text)
        best_height = 0
        best_quality = "SD"
        for m in lib_root.findall(".//Media"):
            h = int(m.get("height", "0") or "0")
            vr = (m.get("videoResolution", "") or "").lower()
            if h > best_height:
                best_height = h
            # Determine quality from videoResolution (more reliable than height for labels)
            q = "SD"
            if "4k" in vr:
                q = "4K"
            elif "1080" in vr:
                q = "1080P"
            elif "720" in vr:
                q = "720P"
            elif "480" in vr:
                q = "480P"
            # Keep the highest quality label
            rank = {"4K": 4, "1080P": 3, "720P": 2, "480P": 1, "SD": 0}
            if rank.get(q, 0) > rank.get(best_quality, 0):
                best_quality = q
        return best_quality, best_height
    except Exception as e:
        logger.debug("Failed to fetch library metadata for %s: %s", rating_key, str(e))
        return "SD", 0


async def get_active_streams() -> list:
    """
    Fetch active Plex sessions.
    Returns list of stream dicts with title, user, transcode info, progress, etc.
    """
    config = _get_config()
    if not config["url"] or not config["token"]:
        return []

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{config['url']}/status/sessions",
                params={"X-Plex-Token": config["token"]},
            )
            if resp.status_code != 200:
                logger.warning("Plex sessions returned HTTP %d", resp.status_code)
                return []

            root = ET.fromstring(resp.text)
            streams = []
            for video in root.findall(".//Video"):
                # Determine transcode vs direct
                media = video.find(".//Media")
                part = video.find(".//Part")
                transcode_session = video.find(".//TranscodeSession")

                is_transcode = transcode_session is not None
                decision = "Transcode" if is_transcode else "Direct Play"
                if transcode_session is not None:
                    video_decision = transcode_session.get("videoDecision", "")
                    if video_decision == "copy":
                        decision = "Direct Stream"

                # Bitrate (source media bitrate, for display only)
                bitrate = 0
                if media is not None:
                    bitrate = int(media.get("bitrate", "0") or "0")

                # Source quality — fetch from library metadata for best available
                source_quality = "SD"
                source_height = 0
                rating_key = video.get("ratingKey", "")
                if rating_key:
                    source_quality, source_height = await _get_best_media_quality(
                        client, config, rating_key
                    )
                # Fallback to session Media if library lookup failed
                if source_quality == "SD" and source_height == 0 and media is not None:
                    source_height = int(media.get("height", "0") or "0")
                    video_resolution = (media.get("videoResolution", "") or "").lower()
                    if "4k" in video_resolution:
                        source_quality = "4K"
                    elif "1080" in video_resolution:
                        source_quality = "1080P"
                    elif "720" in video_resolution:
                        source_quality = "720P"
                    elif "480" in video_resolution:
                        source_quality = "480P"

                # Stream quality (what the user is actually receiving)
                stream_height = source_height
                if transcode_session is not None and transcode_session.get("videoDecision") == "transcode":
                    # Stream quality comes from session Media (what's actually being sent)
                    session_media_height = int(media.get("height", "0") or "0") if media is not None else 0
                    session_media_res = (media.get("videoResolution", "") if media is not None else "").lower()
                    ts_height = int(transcode_session.get("height", "0") or "0")

                    # Use TranscodeSession height if available, else session Media
                    if ts_height > 0:
                        stream_height = ts_height
                    elif session_media_height > 0:
                        stream_height = session_media_height
                    else:
                        stream_height = source_height

                    if stream_height >= 2160:
                        stream_quality = "4K"
                    elif stream_height >= 1080:
                        stream_quality = "1080P"
                    elif stream_height >= 720:
                        stream_quality = "720P"
                    elif stream_height >= 480:
                        stream_quality = "480P"
                    else:
                        # Derive from session Media videoResolution
                        if "1080" in session_media_res:
                            stream_quality = "1080P"
                        elif "720" in session_media_res:
                            stream_quality = "720P"
                        elif "480" in session_media_res:
                            stream_quality = "480P"
                        else:
                            stream_quality = "SD"
                else:
                    stream_quality = source_quality

                # Progress
                duration = int(video.get("duration", "0") or "0")
                view_offset = int(video.get("viewOffset", "0") or "0")
                progress = round((view_offset / duration * 100), 1) if duration > 0 else 0

                # User info
                user = video.find(".//User")
                username = user.get("title", "Unknown") if user is not None else "Unknown"

                # Session info
                session = video.find(".//Session")
                session_id = session.get("id", "") if session is not None else ""

                # Build title with episode info and year
                title = video.get("title", "Unknown")
                year = video.get("year", "")
                grandparent = video.get("grandparentTitle", "")
                parent_index = video.get("parentIndex", "")
                index = video.get("index", "")
                episode_info = ""
                if grandparent:
                    title = grandparent
                    year = ""  # TV shows don't need year
                    if parent_index and index:
                        episode_info = f"S{parent_index.zfill(2)}E{index.zfill(2)}"

                # Thumbnail (return proxy URL so browser loads via HTTPS)
                thumb = video.get("thumb", "")
                thumb_url = ""
                if thumb:
                    from urllib.parse import quote
                    thumb_url = f"/api/integrations/plex/thumb?path={quote(thumb, safe='')}"

                # Player info
                player = video.find(".//Player")
                player_device = player.get("device", "") if player is not None else ""
                player_platform = player.get("platform", "") if player is not None else ""
                player_state = player.get("state", "playing") if player is not None else "playing"

                streams.append({
                    "session_id": session_id,
                    "title": title,
                    "year": year,
                    "episode_info": episode_info,
                    "user": username,
                    "decision": decision,
                    "bitrate": bitrate,
                    "source_quality": source_quality,
                    "source_height": source_height,
                    "stream_quality": stream_quality,
                    "stream_height": stream_height,
                    "progress": progress,
                    "thumb_url": thumb_url,
                    "player_device": player_device,
                    "player_platform": player_platform,
                    "player_state": player_state,
                    "duration": duration,
                    "view_offset": view_offset,
                })

            return streams

    except httpx.TimeoutException:
        logger.warning("Plex connection timed out")
        return []
    except httpx.ConnectError:
        logger.warning("Could not connect to Plex at %s", config["url"])
        return []
    except ET.ParseError:
        logger.warning("Failed to parse Plex XML response")
        return []
    except Exception as e:
        logger.error("Plex integration error: %s", str(e))
        return []


async def get_thumbnail(path: str) -> tuple:
    """
    Fetch a thumbnail image from Plex and return (content_bytes, content_type).
    Returns (None, None) on failure.
    """
    config = _get_config()
    if not config["url"] or not config["token"]:
        return None, None

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{config['url']}/photo/:/transcode",
                params={
                    "width": 300,
                    "height": 170,
                    "minSize": 1,
                    "upscale": 1,
                    "url": path,
                    "X-Plex-Token": config["token"],
                },
            )
            if resp.status_code == 200:
                content_type = resp.headers.get("content-type", "image/jpeg")
                return resp.content, content_type
    except Exception as e:
        logger.warning("Failed to fetch Plex thumbnail: %s", str(e))

    return None, None


# Resolution buckets we report, in the order they are shown. Plex's own filter
# values; "sd" is deliberately absent because it overlaps 480/576 rather than
# being disjoint from them, which made the buckets sum past the library total.
# Anything not 4K/1080/720 is derived as SD instead, so the parts always add up.
_QUALITY_BUCKETS = ("4k", "1080", "720")


async def _section_count(client: httpx.AsyncClient, config: dict, section: str,
                         extra: str = "") -> int:
    """
    How many items match, without fetching any of them.

    X-Plex-Container-Size=0 asks for a zero-length page, so Plex answers with
    just the MediaContainer header carrying totalSize. That turns a resolution
    breakdown into a handful of tiny requests instead of pulling ~57MB of
    episode records out of Sonarr to count them here.
    """
    url = (f"{config['url']}/library/sections/{section}/all"
           f"?X-Plex-Container-Start=0&X-Plex-Container-Size=0{extra}")
    resp = await client.get(url, headers={"X-Plex-Token": config["token"],
                                          "Accept": "application/json"})
    if resp.status_code != 200:
        raise httpx.HTTPError(f"HTTP {resp.status_code}")
    container = (resp.json() or {}).get("MediaContainer") or {}
    return int(container.get("totalSize") or 0)


async def quality_breakdown() -> dict:
    """
    Resolution split of the film and episode libraries.

    Returns {"movies": {...}, "episodes": {...}, "hd_or_better_pct": int}, each
    inner dict holding 4k / 1080 / 720 / sd / total.

    Plex rather than Radarr/Sonarr because it answers with a count instead of a
    payload, and because it is what viewers actually see. Cross-checked against
    Radarr: both report the same 4K film count.
    """
    empty = {"4k": 0, "1080": 0, "720": 0, "sd": 0, "total": 0}
    config = _get_config()
    if not config["url"] or not config["token"]:
        return {"movies": dict(empty), "episodes": dict(empty), "hd_or_better_pct": 0}

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{config['url']}/library/sections",
                headers={"X-Plex-Token": config["token"], "Accept": "application/json"},
            )
            if resp.status_code != 200:
                logger.warning("Plex sections returned HTTP %d", resp.status_code)
                return {"movies": dict(empty), "episodes": dict(empty), "hd_or_better_pct": 0}

            directories = ((resp.json() or {}).get("MediaContainer") or {}).get("Directory") or []
            # Every movie/show section, not a hardcoded key: section numbering
            # differs per install, and an admin can add a second film library.
            movie_sections = [d["key"] for d in directories if d.get("type") == "movie"]
            show_sections = [d["key"] for d in directories if d.get("type") == "show"]

            async def bucket(sections: list, extra: str) -> dict:
                out = dict(empty)
                for key in sections:
                    out["total"] += await _section_count(client, config, key, extra)
                    for b in _QUALITY_BUCKETS:
                        out[b] += await _section_count(client, config, key,
                                                       f"{extra}&resolution={b}")
                # Whatever is left is standard definition. Derived rather than
                # queried so the buckets always sum to the total.
                out["sd"] = max(0, out["total"] - out["4k"] - out["1080"] - out["720"])
                return out

            movies = await bucket(movie_sections, "")
            episodes = await bucket(show_sections, "&type=4")   # type=4 = episode
    except (httpx.RequestError, httpx.HTTPError, ValueError, KeyError) as exc:
        logger.warning("Plex quality breakdown failed: %s", exc)
        return {"movies": dict(empty), "episodes": dict(empty), "hd_or_better_pct": 0}

    total = movies["total"] + episodes["total"]
    # 720p counts as HD - that is what the term means. Excluding it would
    # understate the library and mislabel the figure.
    hd = sum(movies[b] + episodes[b] for b in _QUALITY_BUCKETS)
    return {
        "movies": movies,
        "episodes": episodes,
        "hd_or_better_pct": round(100 * hd / total) if total else 0,
    }
