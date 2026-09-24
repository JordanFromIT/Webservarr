"""
Shared test helpers (not collected: the file name has no test prefix).

make_sessionmaker() gives each test class its own in-memory SQLite database,
so no test ever reads or writes the dev instance's real settings.
"""
from typing import Optional


def make_sessionmaker():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from app import models  # noqa: F401 - registers the tables on Base
    from app.database import Base

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


def put(db, key: str, value: str) -> None:
    from app.models import Setting
    row = db.query(Setting).filter(Setting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(Setting(key=key, value=value))
    db.commit()


def get(db, key: str) -> Optional[str]:
    from app.models import Setting
    db.expire_all()
    row = db.query(Setting).filter(Setting.key == key).first()
    return row.value if row else None


ADMIN = {"username": "admin", "display_name": "Admin", "is_admin": "true",
         "auth_method": "simple", "email": "admin@example.com"}
MEMBER = {"username": "sam", "display_name": "Sam", "is_admin": "false",
          "auth_method": "plex", "email": "sam@example.com"}

# The limiter's enabled state from before api_client() switched it off, so
# reset_overrides() puts back whatever it was rather than forcing it on.
_limiter_was: Optional[bool] = None


def api_client(Session, user=ADMIN):
    """A TestClient whose DB is the in-memory one and whose session is `user`.

    No `with` block on purpose: the lifespan (poller, warmers) must not start.
    Pair every call with reset_overrides() in tearDown."""
    global _limiter_was
    from fastapi.testclient import TestClient

    from app.database import get_db
    from app.dependencies import get_current_user, get_current_user_optional
    from app.limiter import limiter
    from app.main import app

    def _db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_current_user_optional] = lambda: user
    if _limiter_was is None:          # a second call before reset keeps the first saved state
        _limiter_was = limiter.enabled
    set_rate_limits(False)
    return TestClient(app)


def set_rate_limits(enabled: bool) -> None:
    # The limiter is Redis-backed and shared with the running dev instance;
    # tests must neither trip it nor eat the real budget.
    from app.limiter import limiter
    limiter.enabled = enabled


def reset_overrides() -> None:
    """Clear the dependency overrides and restore the limiter's earlier state."""
    global _limiter_was
    from app.main import app
    app.dependency_overrides.clear()
    if _limiter_was is not None:
        set_rate_limits(_limiter_was)
        _limiter_was = None
