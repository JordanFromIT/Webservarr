"""
The suite runs inside the dev container, beside the running instance and its
embedded Redis, and sometimes beside another run of the suite. Before anything
imports the app, every Redis client it makes (sessions, caches, the last push,
the rate limiter, the poller lease, the books catalog lock; all read
settings.redis_url) is pointed at a Redis server of this run's own: a private
redis-server on a free loopback port, started here and stopped when the run
ends. No test can then read, hold, clear or count against a key the instance
or another run is using, and tests that need real Redis semantics still get
real Redis.

A process a test starts (the catalog's two-worker tests) imports this package
too; it finds OWN_REDIS_ENV set by its parent and shares the parent's server.
Where there is no redis-server to start (a laptop without one), the clients
fall back to the configured server with its database replaced by
TEST_REDIS_DB.
"""
import atexit
import os
import re
import shutil
import signal
import socket
import subprocess
import time

TEST_REDIS_DB = 15
OWN_REDIS_ENV = "WEBSERVARR_TEST_REDIS_URL"
START_TIMEOUT_S = 10


def isolated_redis_url(url: str) -> str:
    """``url`` with its database number replaced by TEST_REDIS_DB."""
    base, sep, query = url.partition("?")
    m = re.match(r"^(redis(?:s)?://[^/]*)(?:/\d*)?$", base)
    base = f"{m.group(1)}/{TEST_REDIS_DB}" if m else base
    return base + sep + query


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _die_with_parent() -> None:
    """In the redis-server child: stop when the suite's process ends, even if
    it is killed before its atexit hook can run (Linux only)."""
    try:
        import ctypes
        ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except (OSError, AttributeError):
        pass


def _serves(port: int, proc: subprocess.Popen) -> bool:
    """True once the server on ``port`` answers and is ``proc`` (not some other
    server that took the port first)."""
    deadline = time.monotonic() + START_TIMEOUT_S
    while time.monotonic() < deadline and proc.poll() is None:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1) as s:
                s.sendall(b"INFO server\r\n")
                reply = b""
                m = None
                while m is None:
                    chunk = s.recv(65536)
                    if not chunk:
                        break
                    reply += chunk
                    m = re.search(rb"process_id:(\d+)\r\n", reply)
            return m is not None and int(m.group(1)) == proc.pid
        except OSError:
            time.sleep(0.05)
    return False


def _stop(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def start_own_redis():
    """Start this run's redis-server and return its URL, or None when there is
    no redis-server on this machine."""
    binary = shutil.which("redis-server")
    if binary is None:
        return None
    for _ in range(5):  # a free port can be taken before the server binds it
        port = _free_port()
        proc = subprocess.Popen(
            [binary, "--bind", "127.0.0.1", "--port", str(port), "--save", "", "--appendonly", "no"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            preexec_fn=_die_with_parent,
        )
        if _serves(port, proc):
            atexit.register(_stop, proc)
            return f"redis://127.0.0.1:{port}/0"
        _stop(proc)
    raise RuntimeError("the test suite could not start its own redis-server")


if os.environ.get(OWN_REDIS_ENV):
    os.environ["REDIS_URL"] = os.environ[OWN_REDIS_ENV]
else:
    _own = start_own_redis()
    if _own:
        os.environ[OWN_REDIS_ENV] = _own
        os.environ["REDIS_URL"] = _own
    else:
        os.environ["REDIS_URL"] = isolated_redis_url(os.environ.get("REDIS_URL") or "redis://localhost:6379/0")
