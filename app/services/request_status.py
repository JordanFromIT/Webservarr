"""
Why a requested title has not arrived yet.

Someone asks for a film, it never appears, and there is nothing anywhere that
tells them why. They ask the admin, who has to go and read three different
applications to answer. This module produces that answer once, for every
outstanding request, in terms a viewer can act on.

The classification is derived here rather than received from anywhere: Seerr,
Radarr, Sonarr and Plex are all already configured, and between them they hold
every fact needed. That keeps the page working on any install without extra
moving parts.

TWO AXES, deliberately separate:

  reason_code   why it is not available -- shown on the row
  state_code    where it stands         -- decides which group it renders in

Grouping on state and explaining with reason is what stops codes falling
through: every reason maps to exactly one state, and the five page groups cover
all seven states. Mixing the two axes leaves gaps.

THE AVAILABILITY INVARIANT:

A row may only be reported ALREADY_AVAILABLE if a Plex lookup returned an item
carrying the same TMDB id. Radarr's hasFile is not sufficient. A Sonarr episode
count is not sufficient. On any ambiguity the row stays in the missing set.

The costs are asymmetric. Telling someone a film is ready when it is not sends
them to Plex, fails, and permanently costs the page its credibility. Telling
them it is still missing when it is actually there is the status quo we are
already fixing, and it corrects itself on the next cycle.
"""

import asyncio
import json
import logging
import time
from datetime import datetime, timezone

from app.config import settings

logger = logging.getLogger(__name__)

CACHE_KEY = "webservarr:request_status:v1"
CACHE_TTL = 20 * 60

# Seerr request status codes.
_REQ_PENDING = 1
_REQ_DECLINED = 3

# Seerr media status codes. 5 is available, 4 partially available.
_MEDIA_AVAILABLE = 5
_MEDIA_PARTIAL = 4

# How far past its release date a film has to be before "not out yet" stops
# being the explanation. Release dates in the metadata are frequently a few days
# adrift of reality, and claiming a film is missing when it came out yesterday
# reads as broken.
_RELEASE_GRACE_DAYS = 2

# Every reason maps to exactly one state; the page groups on state.
# A reason missing from here would render ungrouped, so the test suite asserts
# this table covers the full reason set.
REASON_TO_STATE = {
    "AWAITING_APPROVAL": "NEEDS_ADMIN",
    "DECLINED": "ABANDONED",
    "NOT_RELEASED_YET": "WAITING_FOR_RELEASE",
    "NO_RELEASE_FOUND": "SEARCHING",
    "DOWNLOADING": "DOWNLOADING",
    "DOWNLOAD_STALLED": "DOWNLOADING",
    "IMPORT_BLOCKED": "NEEDS_ADMIN",
    "NOT_TRACKED": "NEEDS_ADMIN",
    "NOT_MONITORED": "SEARCHING",
    "TV_PARTIAL": "SEARCHING",
    "ALREADY_AVAILABLE": "AVAILABLE_NOW",
    "UNKNOWN": "NEEDS_ADMIN",
}

# The five groups the page renders, in order, keyed by state.
STATE_TO_GROUP = {
    "AVAILABLE_NOW": "ready",
    "DOWNLOADING": "on_the_way",
    "IMPORTING": "on_the_way",
    "SEARCHING": "on_the_way",
    "WAITING_FOR_RELEASE": "waiting",
    "NEEDS_ADMIN": "needs_look",
    "ABANDONED": "cant_fulfil",
}


def _parse_dt(value):
    """Lenient ISO8601 parse; Seerr and the arrs disagree about the Z suffix."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def _released(movie: dict) -> bool:
    """
    Whether a film is out on a format we could actually obtain.

    Cinema-only does not count: a film in cinemas and nowhere else genuinely
    cannot be downloaded, and telling someone "no release found" for it would
    be blaming the system for physics.
    """
    now = datetime.now(timezone.utc)
    for key in ("digital_release", "physical_release"):
        dt = _parse_dt(movie.get(key))
        if dt and (now - dt).days >= -_RELEASE_GRACE_DAYS:
            return True
    return False


def _classify_movie(req: dict, movie, queue_entry) -> str:
    """Reason code for one film request. `movie`/`queue_entry` may be None."""
    if movie is None:
        return "NOT_TRACKED"

    if queue_entry:
        state = queue_entry.get("tracked_state", "")
        status = queue_entry.get("status", "")
        tracked_status = queue_entry.get("tracked_status", "")
        if "import" in state:
            # Blocked imports carry a warning; a clean import is just the tail
            # end of downloading and needs no explanation of its own.
            if tracked_status in ("warning", "error") or queue_entry.get("messages"):
                return "IMPORT_BLOCKED"
            return "DOWNLOADING"
        if status in ("warning", "failed") or tracked_status in ("warning", "error"):
            return "DOWNLOAD_STALLED"
        return "DOWNLOADING"

    if not movie.get("monitored"):
        return "NOT_MONITORED"
    if not _released(movie):
        return "NOT_RELEASED_YET"
    return "NO_RELEASE_FOUND"


def _classify_tv(req: dict, series, queue_entry) -> str:
    """Reason code for one TV request."""
    if series is None:
        return "NOT_TRACKED"

    if queue_entry:
        if queue_entry.get("stalled"):
            return "DOWNLOAD_STALLED"
        if queue_entry.get("importing"):
            return "DOWNLOADING"
        if queue_entry.get("queued"):
            return "DOWNLOADING"

    if not series.get("monitored"):
        return "NOT_MONITORED"

    # Some episodes present but not all. Note this is only reached when Plex has
    # NOT confirmed the request satisfied, so a "complete" Sonarr count still
    # lands here rather than claiming availability off the count alone.
    if series.get("episode_file_count", 0) > 0:
        return "TV_PARTIAL"
    return "NO_RELEASE_FOUND"


def _plex_hit_is_conclusive(req, by_tvdb, by_tmdb) -> bool:
    """
    Whether a Plex match actually proves this request was satisfied.

    For a film it does. A film is one file: Plex either holds it or it does not,
    so a TMDB match is the whole answer.

    For a series it does not, and assuming otherwise is the trap. A Plex hit
    proves the SHOW exists, not that the seasons somebody asked for are in it.
    Measured against the live library, 42 of 56 series that matched in Plex were
    materially incomplete -- The Muppet Show at 77 of 120 episodes, Johnny Test
    at 100 of 234. Reporting those as "ready to watch now" would send people to
    episodes that are not there, which costs the page its credibility far more
    than leaving a complete show listed as missing for one more cycle.

    So a series needs two independent signals agreeing: present in Plex AND
    Sonarr holding a file for every episode it knows about. Either one alone is
    the weak signal the availability invariant exists to reject. Sonarr's counts
    treat specials inconsistently, so this still errs toward understating
    completeness -- which is the safe direction.
    """
    if req.get("media_type") != "tv":
        return True

    tvdb_id, tmdb_id = req.get("tvdb_id"), req.get("tmdb_id")
    found = by_tvdb.get(int(tvdb_id)) if tvdb_id else None
    if found is None and tmdb_id:
        found = by_tmdb.get(int(tmdb_id))
    if not found:
        return False

    total = found.get("episode_count") or 0
    have = found.get("episode_file_count") or 0
    return total > 0 and have >= total


def classify(requests, movies, movie_queue, series, series_queue, plex_tmdb_ids):
    """
    Turn raw integration data into page rows.

    Pure and synchronous so the decision table can be tested without touching a
    network. Everything it needs has already been fetched by the caller.

    `plex_tmdb_ids` is the set of TMDB ids confirmed present in Plex. It is the
    ONLY thing that may produce ALREADY_AVAILABLE.
    """
    by_tvdb = series.get("by_tvdb", {})
    by_tmdb = series.get("by_tmdb", {})
    rows = []

    for req in requests:
        media_status = req.get("media_status")
        request_status = req.get("request_status")
        tmdb_id = req.get("tmdb_id")
        progress = {}

        # Fulfilled as far as Seerr is concerned: nothing to explain.
        if media_status == _MEDIA_AVAILABLE:
            continue

        if request_status == _REQ_DECLINED:
            reason = "DECLINED"
        elif request_status == _REQ_PENDING:
            reason = "AWAITING_APPROVAL"
        elif (
            tmdb_id
            and int(tmdb_id) in plex_tmdb_ids
            and _plex_hit_is_conclusive(req, by_tvdb, by_tmdb)
        ):
            # Seerr believes this is missing; Plex says otherwise and Plex is
            # the one holding the file. See the invariant at the top, and
            # _plex_hit_is_conclusive for why a hit means different things for
            # a film and for a series.
            reason = "ALREADY_AVAILABLE"
        elif req.get("media_type") == "movie":
            movie = movies.get(int(tmdb_id)) if tmdb_id else None
            queue_entry = movie_queue.get(movie["id"]) if movie else None
            reason = _classify_movie(req, movie, queue_entry)
            if queue_entry:
                progress["percent"] = queue_entry.get("percent")
        elif req.get("media_type") == "tv":
            tvdb_id = req.get("tvdb_id")
            found = by_tvdb.get(int(tvdb_id)) if tvdb_id else None
            if found is None and tmdb_id:
                found = by_tmdb.get(int(tmdb_id))
            queue_entry = series_queue.get(found["id"]) if found else None
            reason = _classify_tv(req, found, queue_entry)
            # Episode counts are the honest answer for a show. "Downloading" on
            # a series with 27 of 59 episodes reads as "nearly here" when it is
            # not; the numbers say what is actually true and the page shows them
            # instead of a verb.
            if found:
                progress["episodes_have"] = found.get("episode_file_count") or 0
                progress["episodes_total"] = found.get("episode_count") or 0
            if queue_entry:
                progress["episodes_queued"] = queue_entry.get("queued") or 0
        else:
            reason = "UNKNOWN"

        # Partially-available TV that nothing else explained is partial, not
        # "nothing found" -- some of it is demonstrably there.
        if reason == "NO_RELEASE_FOUND" and media_status == _MEDIA_PARTIAL:
            reason = "TV_PARTIAL"

        state = REASON_TO_STATE.get(reason, "NEEDS_ADMIN")
        rows.append({
            "request_id": req.get("request_id"),
            "media_type": req.get("media_type"),
            "tmdb_id": tmdb_id,
            "title": req.get("title") or "",
            "year": req.get("year"),
            "is_4k": req.get("is_4k", False),
            "seasons": req.get("seasons"),
            # No requester identity at all -- not the name, not the id. The page
            # shows the state of the request queue, and who asked for what is
            # nobody else's business. Nothing identifying is emitted, so nothing
            # identifying can leak through the API either.
            "requested_at": req.get("requested_at"),
            "reason_code": reason,
            "state_code": state,
            "group": STATE_TO_GROUP.get(state, "needs_look"),
            **progress,
        })

    return rows


def collapse_duplicates(rows):
    """
    Fold repeat requests for the same thing by the same person into one row.

    Somebody who asked for a film twice, months apart, is waiting for one film.
    A page that lists it twice with no visible difference between the rows reads
    as a bug to the audience this is built for.

    The key is media type, TMDB id, 4K and season scope. Requester is
    deliberately NOT part of it: the list describes the state of the queue, not
    who is waiting, so two people asking for the same film are one thing the
    server is trying to fetch and belong on one row. Season scope and 4K do stay
    in the key, because "Season 2" and "Specials" are genuinely different asks
    and one can be satisfied while the other is not.

    The surviving row keeps the newest request id, which reflects current
    intent, but takes the EARLIEST requested_at. Someone who first asked in June
    has been waiting since June; showing them the August re-ask would understate
    the wait, and the wait is the part that conveys the problem.
    """
    groups = {}
    for row in rows:
        seasons = tuple(row.get("seasons") or ())
        key = (
            row.get("media_type"),
            row.get("tmdb_id"),
            bool(row.get("is_4k")),
            seasons,
        )
        groups.setdefault(key, []).append(row)

    collapsed = []
    for members in groups.values():
        if len(members) == 1:
            members[0]["duplicate_count"] = 1
            collapsed.append(members[0])
            continue

        ordered = sorted(members, key=lambda r: r.get("request_id") or 0)
        survivor = dict(ordered[-1])
        earliest = min(
            (r.get("requested_at") for r in ordered if r.get("requested_at")),
            default=survivor.get("requested_at"),
        )
        survivor["requested_at"] = earliest
        survivor["duplicate_count"] = len(ordered)
        survivor["request_ids"] = [r.get("request_id") for r in ordered]
        collapsed.append(survivor)

    return collapsed


def _enrich_titles(rows, movies, series):
    """
    Fill in title/year from whatever source knows them.

    Seerr's request objects do not carry the title, so it comes from the arrs
    where the item is tracked. Untracked rows keep an empty title and the page
    falls back to showing the id -- a nameless row is still more use than a
    missing one.
    """
    by_tmdb = series.get("by_tmdb", {})
    by_tvdb = series.get("by_tvdb", {})
    for row in rows:
        if row["title"]:
            continue
        tmdb_id = row.get("tmdb_id")
        found = None
        if row["media_type"] == "movie" and tmdb_id:
            found = movies.get(int(tmdb_id))
        elif row["media_type"] == "tv" and tmdb_id:
            found = by_tmdb.get(int(tmdb_id))
        if found:
            row["title"] = found.get("title") or ""
            row["year"] = row.get("year") or found.get("year")
    return rows


async def build_snapshot() -> dict:
    """
    Fetch everything, classify it, and return the payload the page renders.

    The four integration calls run concurrently -- they are independent and the
    slowest of them sets the floor. A failure in any one degrades that
    dimension rather than the whole snapshot: an unreachable Radarr means films
    classify as NOT_TRACKED, which is visibly wrong but still a page.
    """
    from app.integrations import radarr, seerr, sonarr, plex

    requests, movies, movie_queue, series, series_queue = await asyncio.gather(
        seerr.get_all_requests(),
        radarr.get_movies_by_tmdb(),
        radarr.get_queue_by_movie_id(),
        sonarr.get_series_by_tvdb(),
        sonarr.get_queue_by_series_id(),
    )

    # Which outstanding rows are worth asking Plex about. Only rows Seerr calls
    # unfulfilled are candidates, so the Plex work stays proportional to the
    # problem rather than to the size of the library.
    candidates, seen = [], set()
    for req in requests:
        if req.get("media_status") == _MEDIA_AVAILABLE:
            continue
        if req.get("request_status") in (_REQ_PENDING, _REQ_DECLINED):
            continue
        tmdb_id = req.get("tmdb_id")
        if not tmdb_id or int(tmdb_id) in seen:
            continue
        title = ""
        if req.get("media_type") == "movie":
            found = movies.get(int(tmdb_id))
            title = found.get("title") if found else ""
        else:
            found = series.get("by_tmdb", {}).get(int(tmdb_id))
            title = found.get("title") if found else ""
        if not title:
            continue
        seen.add(int(tmdb_id))
        candidates.append({
            "tmdb_id": int(tmdb_id),
            "title": title,
            "media_type": req.get("media_type"),
        })

    plex_ids = await plex.tmdb_ids_present(candidates)

    rows = classify(requests, movies, movie_queue, series, series_queue, plex_ids)

    # Anything confirmed present is dropped rather than shown. This list exists
    # to explain what has NOT arrived; a row saying "this one is fine" is noise
    # in a list of problems.
    #
    # The Plex verification above is still doing the work even though none of it
    # is rendered -- it is what stops a title that is actually on the server from
    # appearing here as missing. Removing the check would not simplify this, it
    # would put 38 wrong rows back.
    rows = [r for r in rows if r["reason_code"] != "ALREADY_AVAILABLE"]

    rows = collapse_duplicates(rows)
    rows = _enrich_titles(rows, movies, series)

    # Anything the arrs could not name is asked of Seerr, which proxies TMDB.
    # These are the never-added requests -- also the oldest, so they sort to the
    # top, where a column of "Request #2" would be the first thing anyone sees.
    unnamed = [
        {"tmdb_id": int(r["tmdb_id"]), "media_type": r["media_type"]}
        for r in rows if not r["title"] and r.get("tmdb_id")
    ]
    if unnamed:
        looked_up = await seerr.lookup_titles(unnamed)
        for row in rows:
            found = looked_up.get(row.get("tmdb_id")) if not row["title"] else None
            if found:
                row["title"] = found["title"]
                row["year"] = row.get("year") or found.get("year")

    # Longest wait first within each group: the page's job is to surface what
    # has been stuck, and a six-month-old request matters more than yesterday's.
    rows.sort(key=lambda r: r.get("requested_at") or "")

    counts = {}
    for row in rows:
        counts[row["group"]] = counts.get(row["group"], 0) + 1

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "counts": counts,
        "total": len(rows),
        "plex_verified": len(plex_ids),
        "items": rows,
    }


# --- Cache ------------------------------------------------------------------
#
# Redis rather than a module-level dict: uvicorn runs two workers, so an
# in-process cache would be built twice and a viewer refreshing the page would
# see it flip between two snapshots computed seconds apart.

_redis = None


def _get_redis():
    global _redis
    if _redis is None:
        import redis.asyncio as aioredis
        _redis = aioredis.from_url(settings.redis_url)
    return _redis


async def get_cached_snapshot():
    """The last built snapshot, or None."""
    try:
        raw = await _get_redis().get(CACHE_KEY)
        return json.loads(raw) if raw else None
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not read request-status cache: %s", exc)
        return None


async def store_snapshot(snapshot: dict) -> None:
    try:
        await _get_redis().set(CACHE_KEY, json.dumps(snapshot), ex=CACHE_TTL)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not write request-status cache: %s", exc)


async def refresh() -> dict:
    """Build a snapshot and cache it."""
    started = time.monotonic()
    snapshot = await build_snapshot()
    await store_snapshot(snapshot)
    logger.info(
        "Request status rebuilt: %d outstanding, %d confirmed in Plex, %.1fs",
        snapshot["total"], snapshot["plex_verified"], time.monotonic() - started,
    )
    return snapshot
