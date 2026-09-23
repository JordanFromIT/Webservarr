"""
SQLite database configuration using SQLAlchemy.
"""

from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from app.config import settings

# Create SQLite engine
# connect_args needed for SQLite to work with FastAPI
engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False},
    echo=settings.app_debug,  # Log SQL queries in debug mode
    pool_size=10,
    max_overflow=20,
    pool_timeout=5,
    pool_pre_ping=True,
    pool_recycle=300,
)

# Session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Base class for models
Base = declarative_base()


def get_db():
    """
    Dependency to get database session.
    Use with FastAPI: db: Session = Depends(get_db)
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """
    Initialize database - create all tables and seed default data.
    Call this on application startup.
    """
    from app import models  # Import models to register them
    Base.metadata.create_all(bind=engine, checkfirst=True)

    # Seed defaults
    from app.seed import (
        seed_default_settings, seed_vapid_keys,
        seed_default_news, migrate_requests_rename, seed_wiki_example,
        migrate_setup_completed, migrate_overseerr_to_seerr,
        migrate_nav_sublabels_v2, migrate_home_sublabel_v3, migrate_wiki_sublabel_v4,
        migrate_ticket_creator_email, migrate_drop_push_username_rows,
        migrate_no_email_identity,
    )
    db = SessionLocal()
    try:
        # Schema first: the notification poller selects tickets.creator_email.
        migrate_ticket_creator_email(db)
        migrate_requests_rename(db)
        migrate_overseerr_to_seerr(db)
        seed_default_settings(db)
        # After seeding, so a fresh install has rows to inspect and an existing
        # one is upgraded in the same pass.
        migrate_nav_sublabels_v2(db)
        migrate_home_sublabel_v3(db)
        migrate_wiki_sublabel_v4(db)
        migrate_setup_completed(db)
        migrate_drop_push_username_rows(db)
        migrate_no_email_identity(db)
        seed_vapid_keys(db)
        seed_default_news(db)
        seed_wiki_example(db)
    finally:
        db.close()
