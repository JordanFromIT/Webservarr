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
    echo=settings.app_debug  # Log SQL queries in debug mode
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
    from app.seed import seed_default_admin, seed_default_settings
    db = SessionLocal()
    try:
        seed_default_admin(db)
        seed_default_settings(db)
    finally:
        db.close()
