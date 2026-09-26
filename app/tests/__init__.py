"""
The suite runs inside the dev container, beside the running instance and its
embedded Redis. Before anything imports the app, every Redis client it makes
(sessions, caches, the last push, the rate limiter, the poller lease; all read
settings.redis_url) is pointed at a database of its own, so no test can read,
overwrite or count against the instance's live keys. Tests that need real
Redis semantics still get real Redis.
"""
import os
import re

TEST_REDIS_DB = 15


def isolated_redis_url(url: str) -> str:
    """``url`` with its database number replaced by TEST_REDIS_DB."""
    base, sep, query = url.partition("?")
    m = re.match(r"^(redis(?:s)?://[^/]*)(?:/\d*)?$", base)
    base = f"{m.group(1)}/{TEST_REDIS_DB}" if m else base
    return base + sep + query


os.environ["REDIS_URL"] = isolated_redis_url(os.environ.get("REDIS_URL") or "redis://localhost:6379/0")
