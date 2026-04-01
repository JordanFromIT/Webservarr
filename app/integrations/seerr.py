"""
Seerr media request and issue integration.
Fetches recent media requests, request statistics, search, request creation,
and issue management (list, detail, create, comment).
"""

import asyncio
import logging
import httpx
from app.database import SessionLocal
from app.models import Setting

logger = logging.getLogger(__name__)

TIMEOUT = 5.0

# Seerr request status codes (used on request objects)
REQUEST_STATUS_MAP = {
    1: "pending",
    2: "approved",
    3: "declined",
    4: "available",
    5: "partially_available",
}

# Seerr media status codes (used on media objects and mediaInfo in search)
MEDIA_STATUS_MAP = {
    1: "unknown",
    2: "pending",
    3: "processing",
    4: "partially_available",
    5: "available",
}

# Seerr issue type codes
ISSUE_TYPE_MAP = {
    1: "video",
    2: "audio",
    3: "subtitles",
    4: "other",
}

# Seerr issue status codes
ISSUE_STATUS_MAP = {
    1: "open",
    2: "resolved",
}


def _get_config() -> dict:
    """Read Seerr config from settings table (short-lived session)."""
    db = SessionLocal()
    try:
        url_setting = db.query(Setting).filter(Setting.key == "integration.seerr.url").first()
        key_setting = db.query(Setting).filter(Setting.key == "integration.seerr.api_key").first()
        return {
            "url": url_setting.value.rstrip("/") if url_setting else None,
            "api_key": key_setting.value if key_setting else None,
        }
    finally:
        db.close()


async def _fetch_media_details(client: httpx.AsyncClient, base_url: str, api_key: str,
                               tmdb_id: int, media_type: str) -> dict:
    """Fetch title and poster from Seerr's media detail endpoint."""
    endpoint = "movie" if media_type == "movie" else "tv"
    try:
        resp = await client.get(
            f"{base_url}/api/v1/{endpoint}/{tmdb_id}",
            headers={"X-Api-Key": api_key},
        )
        if resp.status_code == 200:
            data = resp.json()
            title = data.get("title") or data.get("name", "Unknown")
            poster_path = data.get("posterPath", "")
            return {"title": title, "poster_path": poster_path}
    except Exception as e:
        logger.debug("Failed to fetch details for %s/%d: %s", media_type, tmdb_id, e)
    return {"title": "Unknown", "poster_path": ""}


async def get_recent_requests(limit: int = 10) -> list:
    """
    Fetch recent media requests from Seerr.
    Returns list of request dicts with media info, status, and requester.
    """
    config = _get_config()
    if not config["url"] or not config["api_key"]:
        return []

    try:
        async with httpx.AsyncClient(timeout=10.0, verify=False) as client:
            resp = await client.get(
                f"{config['url']}/api/v1/request",
                params={"take": limit, "sort": "added", "skip": 0},
                headers={"X-Api-Key": config["api_key"]},
            )
            if resp.status_code != 200:
                logger.warning("Seerr requests returned HTTP %d", resp.status_code)
                return []

            data = resp.json()
            results = data.get("results", [])

            # Fetch media details (title, poster) concurrently for each request
            async def _placeholder():
                return {"title": "Unknown", "poster_path": ""}

            detail_tasks = []
            for req in results:
                media = req.get("media", {})
                tmdb_id = media.get("tmdbId", 0)
                media_type = req.get("type", "movie")
                if tmdb_id:
                    detail_tasks.append(
                        _fetch_media_details(client, config["url"], config["api_key"], tmdb_id, media_type)
                    )
                else:
                    detail_tasks.append(_placeholder())

            details = await asyncio.gather(*detail_tasks, return_exceptions=True)

            requests = []
            for i, req in enumerate(results):
                media = req.get("media", {})
                media_type = req.get("type", "unknown")

                # Use fetched details for title and poster
                detail = details[i] if not isinstance(details[i], Exception) else {}
                media_title = detail.get("title", "Unknown") if isinstance(detail, dict) else "Unknown"
                poster_path = detail.get("poster_path", "") if isinstance(detail, dict) else ""
                poster_url = f"https://image.tmdb.org/t/p/w200{poster_path}" if poster_path else ""

                # Status — media.status uses media codes, req.status uses request codes
                status_code = media.get("status", 0)
                if status_code:
                    status_label = MEDIA_STATUS_MAP.get(status_code, "unknown")
                else:
                    status_label = REQUEST_STATUS_MAP.get(req.get("status", 1), "pending")

                requests.append({
                    "id": req.get("id", 0),
                    "media_title": media_title,
                    "media_type": media_type,
                    "poster_url": poster_url,
                    "status": status_label,
                    "requested_date": req.get("createdAt", ""),
                    "updated_date": req.get("updatedAt", ""),
                })

            return requests

    except httpx.TimeoutException:
        logger.warning("Seerr connection timed out")
        return []
    except httpx.ConnectError:
        logger.warning("Could not connect to Seerr at %s", config["url"])
        return []
    except Exception as e:
        logger.error("Seerr integration error: %s", str(e))
        return []


async def authenticate_with_plex_token(plex_token: str) -> str | None:
    """
    Authenticate with Seerr using a Plex token.
    Calls POST /api/v1/auth/plex and returns the connect.sid cookie value on success.
    Returns None on failure.
    """
    config = _get_config()
    if not config["url"]:
        return None

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.post(
                f"{config['url']}/api/v1/auth/plex",
                json={"authToken": plex_token},
            )
            if resp.status_code != 200:
                logger.warning("Seerr Plex auth returned HTTP %d", resp.status_code)
                return None

            # Extract connect.sid from Set-Cookie header
            for cookie_header in resp.headers.get_list("set-cookie"):
                if "connect.sid" in cookie_header:
                    # Parse "connect.sid=s%3A....; Path=/; ..."
                    sid_value = cookie_header.split("connect.sid=")[1].split(";")[0]
                    return sid_value

            logger.warning("Seerr Plex auth succeeded but no connect.sid cookie in response")
            return None

    except Exception as e:
        logger.warning("Seerr Plex auth error: %s", str(e))
        return None


async def search_media(query: str, page: int = 1) -> dict:
    """
    Search TMDB via Seerr.
    Returns dict with page, totalPages, totalResults, and normalized results[].
    """
    config = _get_config()
    if not config["url"] or not config["api_key"]:
        return {"page": 1, "totalPages": 0, "totalResults": 0, "results": []}

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{config['url']}/api/v1/search",
                params={"query": query, "page": page, "language": "en"},
                headers={"X-Api-Key": config["api_key"]},
            )
            if resp.status_code != 200:
                logger.warning("Seerr search returned HTTP %d", resp.status_code)
                return {"page": 1, "totalPages": 0, "totalResults": 0, "results": []}

            data = resp.json()
            results = []
            for item in data.get("results", []):
                media_type = item.get("mediaType", "")
                if media_type not in ("movie", "tv"):
                    continue

                # Normalize title (movies use "title", TV uses "name")
                title = item.get("title") or item.get("name", "Unknown")
                release_date = item.get("releaseDate") or item.get("firstAirDate", "")
                year = release_date[:4] if release_date else ""

                poster_path = item.get("posterPath", "")
                poster_url = f"https://image.tmdb.org/t/p/w300{poster_path}" if poster_path else ""

                # Check if already in Seerr (mediaInfo present)
                media_info = item.get("mediaInfo")
                media_status = None
                media_status_4k = None
                if media_info:
                    status_code = media_info.get("status", 0)
                    if status_code and status_code > 1:
                        media_status = MEDIA_STATUS_MAP.get(status_code)
                    status_code_4k = media_info.get("status4k", 0)
                    if status_code_4k and status_code_4k > 1:
                        media_status_4k = MEDIA_STATUS_MAP.get(status_code_4k)

                results.append({
                    "id": item.get("id", 0),
                    "media_type": media_type,
                    "title": title,
                    "year": year,
                    "overview": item.get("overview", ""),
                    "poster_url": poster_url,
                    "vote_average": round(item.get("voteAverage", 0), 1),
                    "media_status": media_status,
                    "media_status_4k": media_status_4k,
                    "media_info_id": media_info.get("id") if media_info else None,
                })

            return {
                "page": data.get("page", 1),
                "totalPages": data.get("totalPages", 0),
                "totalResults": data.get("totalResults", 0),
                "results": results,
            }

    except Exception as e:
        logger.error("Seerr search error: %s", str(e))
        return {"page": 1, "totalPages": 0, "totalResults": 0, "results": []}


async def create_request(media_type: str, media_id: int, is4k: bool = False) -> dict:
    """
    Create a media request in Seerr.
    Returns the response dict on success, or error dict on failure.
    """
    config = _get_config()
    if not config["url"] or not config["api_key"]:
        return {"success": False, "error": "Seerr not configured"}

    try:
        body = {"mediaType": media_type, "mediaId": media_id, "is4k": is4k}
        if media_type == "tv":
            body["seasons"] = "all"

        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.post(
                f"{config['url']}/api/v1/request",
                json=body,
                headers={"X-Api-Key": config["api_key"]},
            )
            if resp.status_code in (200, 201):
                return {"success": True, "data": resp.json()}
            else:
                error_data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                logger.warning("Seerr create request returned HTTP %d: %s", resp.status_code, error_data)
                return {"success": False, "error": error_data.get("message", f"HTTP {resp.status_code}")}

    except Exception as e:
        logger.error("Seerr create request error: %s", str(e))
        return {"success": False, "error": str(e)}


async def get_request_counts() -> dict:
    """Fetch request count statistics from Seerr."""
    config = _get_config()
    if not config["url"] or not config["api_key"]:
        return {"total": 0, "pending": 0, "approved": 0, "available": 0}

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{config['url']}/api/v1/request/count",
                headers={"X-Api-Key": config["api_key"]},
            )
            if resp.status_code != 200:
                return {"total": 0, "pending": 0, "approved": 0, "available": 0}

            data = resp.json()
            return {
                "total": data.get("total", 0),
                "pending": data.get("pending", 0),
                "approved": data.get("approved", 0),
                "available": data.get("available", 0),
            }

    except Exception as e:
        logger.error("Seerr count error: %s", str(e))
        return {"total": 0, "pending": 0, "approved": 0, "available": 0}


# --- Per-user auth helpers ---

async def create_request_as_user(plex_token: str, media_type: str, media_id: int, is4k: bool = False) -> dict:
    """Create a media request attributed to the individual Plex user."""
    config = _get_config()
    if not config["url"]:
        return {"success": False, "error": "Seerr not configured"}

    connect_sid = await authenticate_with_plex_token(plex_token)
    if not connect_sid:
        return {"success": False, "error": "Could not authenticate with Seerr"}

    try:
        body = {"mediaType": media_type, "mediaId": media_id, "is4k": is4k}
        if media_type == "tv":
            body["seasons"] = "all"
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.post(
                f"{config['url']}/api/v1/request",
                json=body,
                headers={"Cookie": f"connect.sid={connect_sid}"},
            )
            if resp.status_code in (200, 201):
                return {"success": True, "data": resp.json()}
            else:
                error_data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                return {"success": False, "error": error_data.get("message", f"HTTP {resp.status_code}")}
    except Exception as e:
        logger.error("Seerr create request (user) error: %s", str(e))
        return {"success": False, "error": str(e)}


# --- Issues ---

async def get_issues(take: int = 20, skip: int = 0, sort: str = "added") -> dict:
    """
    Fetch issues from Seerr with media details.
    Returns dict with results list and pageInfo.
    """
    config = _get_config()
    if not config["url"] or not config["api_key"]:
        return {"results": [], "pageInfo": {"pages": 0, "results": 0}}

    try:
        async with httpx.AsyncClient(timeout=10.0, verify=False) as client:
            resp = await client.get(
                f"{config['url']}/api/v1/issue",
                params={"take": take, "skip": skip, "sort": sort},
                headers={"X-Api-Key": config["api_key"]},
            )
            if resp.status_code != 200:
                logger.warning("Seerr issues returned HTTP %d", resp.status_code)
                return {"results": [], "pageInfo": {"pages": 0, "results": 0}}

            data = resp.json()
            raw_results = data.get("results", [])
            page_info = data.get("pageInfo", {})

            # Fetch media details concurrently
            async def _placeholder():
                return {"title": "Unknown", "poster_path": ""}

            detail_tasks = []
            for issue in raw_results:
                media = issue.get("media", {})
                tmdb_id = media.get("tmdbId", 0)
                media_type = media.get("mediaType", "movie")
                if tmdb_id:
                    detail_tasks.append(
                        _fetch_media_details(client, config["url"], config["api_key"], tmdb_id, media_type)
                    )
                else:
                    detail_tasks.append(_placeholder())

            details = await asyncio.gather(*detail_tasks, return_exceptions=True)

            issues = []
            for i, issue in enumerate(raw_results):
                media = issue.get("media", {})
                media_type = media.get("mediaType", "movie")

                detail = details[i] if not isinstance(details[i], Exception) else {}
                media_title = detail.get("title", "Unknown") if isinstance(detail, dict) else "Unknown"
                poster_path = detail.get("poster_path", "") if isinstance(detail, dict) else ""
                poster_url = f"https://image.tmdb.org/t/p/w200{poster_path}" if poster_path else ""

                issue_type = ISSUE_TYPE_MAP.get(issue.get("issueType", 0), "other")
                issue_status = ISSUE_STATUS_MAP.get(issue.get("status", 1), "open")

                issues.append({
                    "id": issue.get("id", 0),
                    "media_title": media_title,
                    "media_type": media_type,
                    "poster_url": poster_url,
                    "issue_type": issue_type,
                    "status": issue_status,
                    "problem_season": issue.get("problemSeason", 0),
                    "problem_episode": issue.get("problemEpisode", 0),
                    "created_date": issue.get("createdAt", ""),
                    "updated_date": issue.get("updatedAt", ""),
                })

            return {
                "results": issues,
                "pageInfo": {
                    "pages": page_info.get("pages", 0),
                    "results": page_info.get("results", 0),
                },
            }

    except httpx.TimeoutException:
        logger.warning("Seerr issues connection timed out")
        return {"results": [], "pageInfo": {"pages": 0, "results": 0}}
    except Exception as e:
        logger.error("Seerr issues error: %s", str(e))
        return {"results": [], "pageInfo": {"pages": 0, "results": 0}}


async def get_issue_counts() -> dict:
    """Fetch issue count statistics from Seerr."""
    config = _get_config()
    if not config["url"] or not config["api_key"]:
        return {"total": 0, "open": 0, "closed": 0, "video": 0, "audio": 0, "subtitles": 0, "other": 0}

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{config['url']}/api/v1/issue/count",
                headers={"X-Api-Key": config["api_key"]},
            )
            if resp.status_code != 200:
                return {"total": 0, "open": 0, "closed": 0, "video": 0, "audio": 0, "subtitles": 0, "other": 0}

            data = resp.json()
            return {
                "total": data.get("total", 0),
                "open": data.get("open", 0),
                "closed": data.get("closed", 0),
                "video": data.get("video", 0),
                "audio": data.get("audio", 0),
                "subtitles": data.get("subtitles", 0),
                "other": data.get("others", 0),
            }

    except Exception as e:
        logger.error("Seerr issue count error: %s", str(e))
        return {"total": 0, "open": 0, "closed": 0, "video": 0, "audio": 0, "subtitles": 0, "other": 0}


async def get_issue_detail(issue_id: int) -> dict:
    """Fetch a single issue with comments from Seerr."""
    config = _get_config()
    if not config["url"] or not config["api_key"]:
        return {}

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{config['url']}/api/v1/issue/{issue_id}",
                headers={"X-Api-Key": config["api_key"]},
            )
            if resp.status_code != 200:
                return {}

            issue = resp.json()
            media = issue.get("media", {})
            tmdb_id = media.get("tmdbId", 0)
            media_type = media.get("mediaType", "movie")

            detail = await _fetch_media_details(client, config["url"], config["api_key"], tmdb_id, media_type) if tmdb_id else {"title": "Unknown", "poster_path": ""}

            poster_path = detail.get("poster_path", "")
            comments = []
            for c in issue.get("comments", []):
                comments.append({
                    "id": c.get("id", 0),
                    "message": c.get("message", ""),
                    "created_date": c.get("createdAt", ""),
                })

            return {
                "id": issue.get("id", 0),
                "media_title": detail.get("title", "Unknown"),
                "media_type": media_type,
                "poster_url": f"https://image.tmdb.org/t/p/w200{poster_path}" if poster_path else "",
                "issue_type": ISSUE_TYPE_MAP.get(issue.get("issueType", 0), "other"),
                "status": ISSUE_STATUS_MAP.get(issue.get("status", 1), "open"),
                "problem_season": issue.get("problemSeason", 0),
                "problem_episode": issue.get("problemEpisode", 0),
                "created_date": issue.get("createdAt", ""),
                "comments": comments,
            }

    except Exception as e:
        logger.error("Seerr issue detail error: %s", str(e))
        return {}


async def create_issue(plex_token: str, issue_type: int, message: str, media_id: int) -> dict:
    """
    Create an issue in Seerr attributed to the user's Plex account.
    Uses plex_token -> connect.sid for per-user authentication.
    """
    config = _get_config()
    if not config["url"]:
        return {"success": False, "error": "Seerr not configured"}

    connect_sid = await authenticate_with_plex_token(plex_token)
    if not connect_sid:
        return {"success": False, "error": "Could not authenticate with Seerr. Try logging out and back in."}

    try:
        body = {"issueType": issue_type, "message": message, "mediaId": media_id}
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.post(
                f"{config['url']}/api/v1/issue",
                json=body,
                headers={"Cookie": f"connect.sid={connect_sid}"},
            )
            if resp.status_code in (200, 201):
                return {"success": True, "data": resp.json()}
            else:
                error_data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                logger.warning("Seerr create issue returned HTTP %d: %s", resp.status_code, error_data)
                return {"success": False, "error": error_data.get("message", f"HTTP {resp.status_code}")}

    except Exception as e:
        logger.error("Seerr create issue error: %s", str(e))
        return {"success": False, "error": str(e)}


async def create_issue_comment(plex_token: str, issue_id: int, message: str) -> dict:
    """Add a comment to an issue, attributed to the user's Plex account."""
    config = _get_config()
    if not config["url"]:
        return {"success": False, "error": "Seerr not configured"}

    connect_sid = await authenticate_with_plex_token(plex_token)
    if not connect_sid:
        return {"success": False, "error": "Could not authenticate with Seerr. Try logging out and back in."}

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.post(
                f"{config['url']}/api/v1/issue/{issue_id}/comment",
                json={"message": message},
                headers={"Cookie": f"connect.sid={connect_sid}"},
            )
            if resp.status_code in (200, 201):
                return {"success": True, "data": resp.json()}
            else:
                error_data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                return {"success": False, "error": error_data.get("message", f"HTTP {resp.status_code}")}

    except Exception as e:
        logger.error("Seerr create comment error: %s", str(e))
        return {"success": False, "error": str(e)}


async def get_backdrops() -> list:
    """
    Fetch trending backdrop image URLs via Seerr's /api/v1/backdrops endpoint.
    Returns list of full TMDB image URLs. Empty list on failure.
    """
    config = _get_config()
    if not config["url"] or not config["api_key"]:
        return []

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.get(
                f"{config['url']}/api/v1/backdrops",
                headers={"X-Api-Key": config["api_key"]},
            )
            if resp.status_code != 200:
                logger.warning("Seerr backdrops returned HTTP %d", resp.status_code)
                return []

            paths = resp.json()
            if not isinstance(paths, list):
                return []

            return [
                f"https://image.tmdb.org/t/p/original{p}"
                for p in paths
                if isinstance(p, str) and p.startswith("/")
            ]
    except Exception as e:
        logger.debug("Failed to fetch Seerr backdrops: %s", str(e))
        return []


# Discover list type → Seerr endpoint path
DISCOVER_ENDPOINT_MAP = {
    "trending": "/api/v1/discover/trending",
    "popular-movies": "/api/v1/discover/movies",
    "upcoming-movies": "/api/v1/discover/movies/upcoming",
    "popular-series": "/api/v1/discover/tv",
    "upcoming-series": "/api/v1/discover/tv/upcoming",
}


async def get_discover_list(list_type: str, page: int = 1) -> list:
    """
    Fetch a Seerr discover list and normalize results to the same shape as search_media.
    list_type: one of "trending", "popular-movies", "upcoming-movies",
               "popular-series", "upcoming-series"
    Returns empty list on config missing, unknown list_type, HTTP error, or timeout.
    """
    config = _get_config()
    if not config["url"] or not config["api_key"]:
        return []

    endpoint = DISCOVER_ENDPOINT_MAP.get(list_type)
    if not endpoint:
        logger.warning("Unknown discover list type: %s", list_type)
        return []

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{config['url']}{endpoint}",
                params={"page": page, "language": "en"},
                headers={"X-Api-Key": config["api_key"]},
            )
            if resp.status_code != 200:
                logger.warning("Seerr discover/%s returned HTTP %d", list_type, resp.status_code)
                return []

            data = resp.json()
            results = []
            for item in data.get("results", []):
                media_type = item.get("mediaType", "")
                if media_type not in ("movie", "tv"):
                    continue

                title = item.get("title") or item.get("name", "Unknown")
                release_date = item.get("releaseDate") or item.get("firstAirDate", "")
                year = release_date[:4] if release_date else ""

                poster_path = item.get("posterPath", "")
                poster_url = f"https://image.tmdb.org/t/p/w300{poster_path}" if poster_path else ""

                media_info = item.get("mediaInfo")
                media_status = None
                media_status_4k = None
                if media_info:
                    status_code = media_info.get("status", 0)
                    if status_code and status_code > 1:
                        media_status = MEDIA_STATUS_MAP.get(status_code)
                    status_code_4k = media_info.get("status4k", 0)
                    if status_code_4k and status_code_4k > 1:
                        media_status_4k = MEDIA_STATUS_MAP.get(status_code_4k)

                results.append({
                    "id": item.get("id", 0),
                    "media_type": media_type,
                    "title": title,
                    "year": year,
                    "overview": item.get("overview", ""),
                    "poster_url": poster_url,
                    "vote_average": round(item.get("voteAverage", 0), 1),
                    "media_status": media_status,
                    "media_status_4k": media_status_4k,
                    "media_info_id": media_info.get("id") if media_info else None,
                })

            return results

    except httpx.TimeoutException:
        logger.warning("Seerr discover/%s connection timed out", list_type)
        return []
    except Exception as e:
        logger.error("Seerr discover/%s error: %s", list_type, e)
        return []
