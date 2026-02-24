"""
Database models for HMS Dashboard.
"""

from sqlalchemy import Column, Integer, String, Text, Boolean, DateTime, Enum
from sqlalchemy.sql import func
from datetime import datetime
from app.database import Base
import enum


class ServiceStatus(str, enum.Enum):
    """Service status enum."""
    UP = "up"
    DEGRADED = "degraded"
    DOWN = "down"
    MAINTENANCE = "maintenance"


class NewsPost(Base):
    """News posts for the dashboard."""
    __tablename__ = "news_posts"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(200), nullable=False)
    content = Column(Text, nullable=False)  # Markdown content
    content_html = Column(Text, nullable=False)  # Rendered HTML (sanitized)

    # Metadata
    author_id = Column(String(100), nullable=False)  # From OIDC userinfo
    author_name = Column(String(100), nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    # Publishing
    published = Column(Boolean, default=False, nullable=False)
    published_at = Column(DateTime, nullable=True)
    pinned = Column(Boolean, default=False, nullable=False)

    def __repr__(self):
        return f"<NewsPost(id={self.id}, title='{self.title}')>"


class Service(Base):
    """Service registry for status monitoring."""
    __tablename__ = "services"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False, unique=True)
    display_name = Column(String(100), nullable=False)
    description = Column(String(200), nullable=True)

    # Status
    status = Column(Enum(ServiceStatus), default=ServiceStatus.UP, nullable=False)
    status_message = Column(String(200), nullable=True)
    last_checked = Column(DateTime, server_default=func.now(), nullable=False)

    # Configuration
    url = Column(String(200), nullable=True)  # Service URL
    health_check_url = Column(String(200), nullable=True)  # Health check endpoint
    embed_url = Column(String(200), nullable=True)  # For iframe embedding
    icon = Column(String(50), nullable=True)  # Material icon name

    # Access control
    enabled = Column(Boolean, default=True, nullable=False)
    requires_auth = Column(Boolean, default=True, nullable=False)

    def __repr__(self):
        return f"<Service(name='{self.name}', status='{self.status}')>"


class StatusUpdate(Base):
    """Incident and maintenance updates."""
    __tablename__ = "status_updates"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(200), nullable=False)
    message = Column(Text, nullable=False)

    # Type of update
    update_type = Column(String(20), nullable=False)  # incident, maintenance, resolved
    severity = Column(String(20), nullable=False)  # info, warning, critical

    # Associated service (optional)
    service_name = Column(String(100), nullable=True)

    # Metadata
    author_id = Column(String(100), nullable=False)
    author_name = Column(String(100), nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    # Status
    active = Column(Boolean, default=True, nullable=False)
    resolved_at = Column(DateTime, nullable=True)

    def __repr__(self):
        return f"<StatusUpdate(id={self.id}, type='{self.update_type}')>"


class User(Base):
    """User accounts for authentication."""
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, nullable=False, index=True)
    email = Column(String(200), nullable=True)
    display_name = Column(String(100), nullable=False)
    password_hash = Column(String(200), nullable=False)
    is_admin = Column(Boolean, default=False, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, server_default=func.now())
    last_login = Column(DateTime, nullable=True)

    def __repr__(self):
        return f"<User(username='{self.username}', admin={self.is_admin})>"


class Setting(Base):
    """Application settings (theme, site config, etc.)."""
    __tablename__ = "settings"

    key = Column(String(100), primary_key=True)
    value = Column(Text, nullable=False)
    description = Column(String(200), nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    def __repr__(self):
        return f"<Setting(key='{self.key}')>"
