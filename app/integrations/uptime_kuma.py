"""
Uptime Kuma monitoring integration.
Fetches service status from Uptime Kuma's public status page API.
"""

import logging
import httpx
from sqlalchemy.orm import Session
from app.models import Setting

logger = logging.getLogger(__name__)

TIMEOUT = 5.0
CONFIG_TIMEOUT = 10.0  # Config endpoint is slower on first call

# Map Uptime Kuma status codes to our ServiceStatus values
STATUS_MAP = {
    0: "down",
    1: "up",
    2: "degraded",  # pending
    3: "maintenance",
}


def _get_config(db: Session) -> dict:
    """Read Uptime Kuma config from settings table."""
    url_setting = db.query(Setting).filter(Setting.key == "integration.uptime_kuma.url").first()
    slug_setting = db.query(Setting).filter(Setting.key == "integration.uptime_kuma.slug").first()
    return {
        "url": url_setting.value.rstrip("/") if url_setting else None,
        "slug": slug_setting.value if slug_setting else "default",
    }


async def get_monitors(db: Session) -> list:
    """
    Fetch monitor status from Uptime Kuma's public status page API.
    Returns list of monitor dicts compatible with our Service model format.
    """
    config = _get_config(db)
    if not config["url"]:
        return []

    slug = config["slug"]

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            # Fetch the public status page heartbeat data
            resp = await client.get(f"{config['url']}/api/status-page/heartbeat/{slug}")
            if resp.status_code != 200:
                logger.warning("Uptime Kuma heartbeat returned HTTP %d", resp.status_code)
                return []

            data = resp.json()
            heartbeat_list = data.get("heartbeatList", {})
            uptime_list = data.get("uptimeList", {})

            # Also fetch the status page config to get monitor names/groups
            # Use longer timeout — this endpoint is slow on first call
            config_resp = await client.get(
                f"{config['url']}/api/status-page/{slug}",
                timeout=CONFIG_TIMEOUT,
            )
            monitor_names = {}
            if config_resp.status_code == 200:
                config_data = config_resp.json()
                for group in config_data.get("publicGroupList", []):
                    for monitor in group.get("monitorList", []):
                        monitor_names[monitor["id"]] = monitor.get("name", f"Monitor {monitor['id']}")

            monitors = []
            for monitor_id_str, heartbeats in heartbeat_list.items():
                monitor_id = int(monitor_id_str)
                name = monitor_names.get(monitor_id, f"Monitor {monitor_id}")

                # Get latest heartbeat
                latest = heartbeats[-1] if heartbeats else None
                if not latest:
                    continue

                status_code = latest.get("status", 0)
                status = STATUS_MAP.get(status_code, "down")
                response_time = latest.get("ping", 0)

                # Get uptime percentage
                uptime_key_24h = f"{monitor_id}_24"
                uptime_key_720h = f"{monitor_id}_720"
                uptime_24h = uptime_list.get(uptime_key_24h, 0)
                uptime_30d = uptime_list.get(uptime_key_720h, 0)

                monitors.append({
                    "id": monitor_id,
                    "name": name,
                    "status": status,
                    "response_time": response_time,
                    "uptime_24h": round(uptime_24h * 100, 2) if uptime_24h <= 1 else round(uptime_24h, 2),
                    "uptime_30d": round(uptime_30d * 100, 2) if uptime_30d <= 1 else round(uptime_30d, 2),
                    "last_check": latest.get("time", ""),
                    "status_message": latest.get("msg", ""),
                })

            return monitors

    except httpx.TimeoutException:
        logger.warning("Uptime Kuma connection timed out")
        return []
    except httpx.ConnectError:
        logger.warning("Could not connect to Uptime Kuma at %s", config["url"])
        return []
    except Exception as e:
        logger.error("Uptime Kuma integration error: %s", str(e))
        return []
