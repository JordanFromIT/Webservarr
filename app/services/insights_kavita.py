"""
The nightly Kavita read for Insights (docs/superpowers/specs/2026-10-10-insights-design.md,
section 4.3, phase C). With the admin key (the catalog's own exchange,
kavita._token), for everyone who has connected Kavita (kavita_links): the
minutes Kavita measured them reading each day (Kavita's admin-only
/api/Stats/reading-counts), kept in reading_minutes. These are Kavita's own
figure, from its reading sessions, not something WebServarr measured.

Kavita 0.9 refuses the admin key another person's lifetime totals and
reading history (spec 4.3, "Proof"), so pages and ebook places stay the
per-person snapshots each person's own link takes (phase B).

Run from the notification poller's leader loop, which asks every
CHECK_INTERVAL; it runs at most once per SWEEP_EVERY, by a settings row, so a
restart or a new leader does not run it twice. One person at a time: Kavita
is one small server across the tunnel. Every call is a GET, after the token
exchange. A failure is recorded (ERROR_KEY: a fixed sentence, never an
address or a key) so the page can say Kavita's figures may be a day behind,
and the sweep is tried again an hour later; the next sweep that works clears
it. Kavita not set up is nothing to do, not a failure.
"""
import logging
from collections import Counter
from datetime import date, datetime, timedelta
from typing import Optional

import httpx
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.integrations import kavita
from app.models import KavitaLink, ReadingMinutes, Setting
from app.services import insights_store
from app.utils import utc_iso

logger = logging.getLogger(__name__)

CHECK_INTERVAL = 10 * 60
SWEEP_EVERY = timedelta(hours=20)
RETRY_AFTER = timedelta(hours=1)
# Kavita counts a session on the day it began, once it has ended, so the
# last few days kept are asked for again.
OVERLAP = timedelta(days=3)
SWEPT_AT_KEY = "insights.kavita_swept_at"
ERROR_KEY = "insights.kavita_sweep_error"


def _client() -> httpx.AsyncClient:
    """A client per sweep. The tests replace this with one on a MockTransport."""
    return httpx.AsyncClient(timeout=kavita.TIMEOUT)


def _setting(db: Session, key: str) -> str:
    row = db.query(Setting.value).filter(Setting.key == key).first()
    return (row[0] or "") if row else ""


def _put(db: Session, key: str, value: str, description: str) -> None:
    row = db.query(Setting).filter(Setting.key == key).first()
    if row is None:
        db.add(Setting(key=key, value=value, description=description))
    else:
        row.value = value
    db.commit()


def last_error(db: Session) -> str:
    """Why the last sweep failed, or "" when it worked (or none has run)."""
    return _setting(db, ERROR_KEY)


def _due(db: Session, now: datetime) -> bool:
    try:
        last = datetime.fromisoformat(_setting(db, SWEPT_AT_KEY).replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return True
    return now - last >= SWEEP_EVERY or last - now > SWEEP_EVERY      # a clock that jumped back


def _from_day(db: Session, identity: str, today: date) -> date:
    """The first day to ask Kavita for: OVERLAP before the latest day kept for
    this person, or KEEP_DAYS back for someone with none kept yet."""
    first = today - timedelta(days=insights_store.KEEP_DAYS)
    latest = db.query(func.max(ReadingMinutes.day)).filter(ReadingMinutes.identity == identity).scalar()
    return first if latest is None else max(first, latest - OVERLAP)


async def _minutes(client: httpx.AsyncClient, base: str, headers: dict, db: Session, identity: str,
                   user_id: int, now: datetime) -> int:
    """Keep the minutes Kavita measured this person reading each UTC day, all
    formats together. Returns how many days with minutes were kept."""
    start = _from_day(db, identity, now.date())
    entries, _h = await kavita._get_json(client, "GET", f"{base}/api/Stats/reading-counts", headers,
                                         params={"userId": user_id, "StartDate": f"{start.isoformat()}T00:00:00Z",
                                                 "TimeZoneId": "UTC"})
    per_day: Counter = Counter()
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        count = entry.get("count")
        try:
            day = date.fromisoformat(str(entry.get("value"))[:10])
        except ValueError:
            continue
        if isinstance(count, int) and not isinstance(count, bool) and count > 0:
            per_day[day] += count
    return insights_store.best_effort(db, "Kavita's reading minutes", insights_store.record_reading_minutes,
                                      identity, dict(per_day), now) or 0


async def sweep(now: Optional[datetime] = None) -> dict:
    """One sweep when it is due: {"people", "days"}, or {"skipped": True}."""
    now = now or insights_store.now_utc()
    db = SessionLocal()
    try:
        if not _due(db, now):
            return {"skipped": True}
        try:
            base, key = kavita._config()
        except kavita.KavitaUnavailable:
            return {"skipped": True}                                  # Kavita is not set up
        links = db.query(KavitaLink.identity, KavitaLink.kavita_user_id, KavitaLink.kavita_username).all()
        if not links:
            return {"skipped": True}
        _put(db, SWEPT_AT_KEY, utc_iso(now), "Insights' Kavita sweep last ran (internal)")
        people = days = 0
        try:
            async with _client() as client:
                headers = {"Authorization": f"Bearer {await kavita._token(client, base, key)}"}
                users, _h = await kavita._get_json(client, "GET", f"{base}/api/Users", headers)
                by_name = {str(u.get("username") or "").casefold(): u.get("id") for u in users
                           if isinstance(u, dict) and isinstance(u.get("id"), int)} if isinstance(users, list) else {}
                for identity, user_id, username in links:
                    user_id = user_id or by_name.get((username or "").casefold())
                    if not isinstance(user_id, int):
                        continue
                    days += await _minutes(client, base, headers, db, identity, user_id, now)
                    people += 1
        except kavita.KavitaUnavailable as exc:
            logger.warning("Insights' Kavita sweep failed: %s", exc)
            _put(db, ERROR_KEY, str(exc)[:200], "Why Insights' last Kavita sweep failed (internal)")
            _put(db, SWEPT_AT_KEY, utc_iso(now - SWEEP_EVERY + RETRY_AFTER),
                 "Insights' Kavita sweep last ran (internal)")
            return {"people": people, "days": days, "error": True}
        _put(db, ERROR_KEY, "", "Why Insights' last Kavita sweep failed (internal)")
        return {"people": people, "days": days}
    finally:
        db.close()
