"""
Netdata system monitoring integration.
Fetches CPU usage, RAM usage, uptime, and hostname from a Netdata agent.
"""

import logging
import httpx
from sqlalchemy.orm import Session
from app.models import Setting

logger = logging.getLogger(__name__)

TIMEOUT = 5.0


def _get_config(db: Session) -> dict:
    """Read Netdata config from settings table."""
    url_setting = db.query(Setting).filter(Setting.key == "integration.netdata.url").first()
    key_setting = db.query(Setting).filter(Setting.key == "integration.netdata.api_key").first()
    cpu_label = db.query(Setting).filter(Setting.key == "netdata.cpu_label").first()
    ram_label = db.query(Setting).filter(Setting.key == "netdata.ram_label").first()
    net_label = db.query(Setting).filter(Setting.key == "netdata.net_label").first()
    return {
        "url": url_setting.value.rstrip("/") if url_setting else None,
        "api_key": key_setting.value if key_setting else None,
        "cpu_label": cpu_label.value if cpu_label else None,
        "ram_label": ram_label.value if ram_label else None,
        "net_label": net_label.value if net_label else None,
    }


def _build_headers(api_key: str | None) -> dict:
    """Build request headers, optionally including API key for auth."""
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


async def get_system_stats(db: Session) -> dict:
    """
    Fetch system stats from Netdata.
    Returns dict with cpu_percent, ram_used_mb, ram_total_mb, ram_percent,
    uptime_seconds, hostname, and ip.
    """
    config = _get_config(db)
    if not config["url"]:
        return {"configured": False}

    headers = _build_headers(config["api_key"])
    result = {
        "configured": True,
        "cpu_percent": None,
        "cpu_cores": None,
        "cpu_label": config["cpu_label"],
        "ram_label": config["ram_label"],
        "net_label": config["net_label"],
        "ram_used_mb": None,
        "ram_total_mb": None,
        "ram_percent": None,
        "uptime_seconds": None,
        "hostname": None,
        "net_download_mbps": None,
        "net_upload_mbps": None,
    }

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            # Fetch CPU usage
            try:
                cpu_resp = await client.get(
                    f"{config['url']}/api/v1/data",
                    params={
                        "chart": "system.cpu",
                        "after": -1,
                        "points": 1,
                        "format": "json",
                    },
                    headers=headers,
                )
                if cpu_resp.status_code == 200:
                    cpu_data = cpu_resp.json()
                    # Netdata returns data as [[timestamp, val1, val2, ...]]
                    # Sum all CPU dimensions for total usage percentage
                    if cpu_data.get("data") and len(cpu_data["data"]) > 0:
                        row = cpu_data["data"][0]
                        # First element is timestamp, rest are CPU dimensions
                        cpu_total = sum(v for v in row[1:] if v is not None)
                        result["cpu_percent"] = round(cpu_total, 1)
            except Exception as e:
                logger.warning("Netdata CPU fetch error: %s", str(e))

            # Fetch RAM usage
            try:
                ram_resp = await client.get(
                    f"{config['url']}/api/v1/data",
                    params={
                        "chart": "system.ram",
                        "after": -1,
                        "points": 1,
                        "format": "json",
                    },
                    headers=headers,
                )
                if ram_resp.status_code == 200:
                    ram_data = ram_resp.json()
                    labels = ram_data.get("labels", [])
                    if ram_data.get("data") and len(ram_data["data"]) > 0:
                        row = ram_data["data"][0]
                        # Build a label->value map (skip timestamp at index 0)
                        values = {}
                        for i, label in enumerate(labels):
                            if i > 0 and i < len(row):
                                values[label.lower()] = row[i]
                            elif i == 0:
                                continue

                        # RAM values are in MiB from Netdata
                        used = values.get("used", 0) or 0
                        cached = values.get("cached", 0) or 0
                        buffers = values.get("buffers", 0) or 0
                        free = values.get("free", 0) or 0

                        total = used + cached + buffers + free
                        # "used" from Netdata includes only actual used (not buffers/cache)
                        result["ram_used_mb"] = round(used)
                        result["ram_total_mb"] = round(total)
                        if total > 0:
                            result["ram_percent"] = round((used / total) * 100, 1)
            except Exception as e:
                logger.warning("Netdata RAM fetch error: %s", str(e))

            # Fetch system info (hostname, uptime)
            try:
                info_resp = await client.get(
                    f"{config['url']}/api/v1/info",
                    headers=headers,
                )
                if info_resp.status_code == 200:
                    info_data = info_resp.json()
                    result["hostname"] = info_data.get("hostname")
                    result["cpu_cores"] = info_data.get("cores_total")
                    # Uptime may be in different locations depending on Netdata version
                    if "host_labels" in info_data:
                        result["hostname"] = result["hostname"] or info_data["host_labels"].get("_hostname")
            except Exception as e:
                logger.warning("Netdata info fetch error: %s", str(e))

            # Fetch uptime from system.uptime chart
            try:
                uptime_resp = await client.get(
                    f"{config['url']}/api/v1/data",
                    params={
                        "chart": "system.uptime",
                        "after": -1,
                        "points": 1,
                        "format": "json",
                    },
                    headers=headers,
                )
                if uptime_resp.status_code == 200:
                    uptime_data = uptime_resp.json()
                    if uptime_data.get("data") and len(uptime_data["data"]) > 0:
                        row = uptime_data["data"][0]
                        if len(row) > 1 and row[1] is not None:
                            result["uptime_seconds"] = int(row[1])
            except Exception as e:
                logger.warning("Netdata uptime fetch error: %s", str(e))

            # Fetch network throughput
            try:
                net_resp = await client.get(
                    f"{config['url']}/api/v1/data",
                    params={
                        "chart": "system.net",
                        "after": -1,
                        "points": 1,
                        "format": "json",
                    },
                    headers=headers,
                )
                if net_resp.status_code == 200:
                    net_data = net_resp.json()
                    labels = net_data.get("labels", [])
                    if net_data.get("data") and len(net_data["data"]) > 0:
                        row = net_data["data"][0]
                        values = {}
                        for i, label in enumerate(labels):
                            if i > 0 and i < len(row):
                                values[label.lower()] = row[i]
                        # Netdata returns kilobits/s; convert to MB/s
                        received = abs(values.get("received", 0) or 0)
                        sent = abs(values.get("sent", 0) or 0)
                        result["net_download_mbps"] = round(received / 8000, 2)
                        result["net_upload_mbps"] = round(sent / 8000, 2)
            except Exception as e:
                logger.warning("Netdata network fetch error: %s", str(e))

    except httpx.TimeoutException:
        logger.warning("Netdata connection timed out")
        return {"configured": True, "error": "Connection timed out"}
    except httpx.ConnectError:
        logger.warning("Could not connect to Netdata at %s", config["url"])
        return {"configured": True, "error": "Connection failed"}
    except Exception as e:
        logger.error("Netdata integration error: %s", str(e))
        return {"configured": True, "error": str(e)}

    return result
