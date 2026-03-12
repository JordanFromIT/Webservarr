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
        seed_default_news, migrate_news_rebrand, migrate_requests_rename,
        migrate_setup_completed,
    )
    db = SessionLocal()
    try:
        migrate_requests_rename(db)
        seed_default_settings(db)
        migrate_setup_completed(db)
        seed_vapid_keys(db)
        seed_default_news(db)
        migrate_news_rebrand(db)
    finally:
        db.close()
