"""
Database models for WebServarr.
"""

from sqlalchemy import Column, Integer, String, Text, Boolean, DateTime, Enum, Float, ForeignKey, Index
from sqlalchemy.sql import func
from datetime import datetime
from app.database import Base
import enum
import uuid


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
    # Permanent account id, never reused: SQLite gives a deleted top row's
    # id to the next user, so tickets are owned by "local:<uid>", not the id.
    # Backfilled for existing users by seed.migrate_user_uid.
    uid = Column(String(36), unique=True, index=True, nullable=True, default=lambda: str(uuid.uuid4()))
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


class Notification(Base):
    """User notifications."""
    __tablename__ = "notifications"

    id = Column(Integer, primary_key=True, index=True)
    user_email = Column(String(200), nullable=False, index=True)
    category = Column(String(20), nullable=False)  # request, issue, service, news
    title = Column(String(200), nullable=False)
    body = Column(Text, nullable=True)
    reference_id = Column(String(100), nullable=True)  # External ID for dedup
    read = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    def __repr__(self):
        return f"<Notification(id={self.id}, category='{self.category}', user='{self.user_email}')>"


class PushSubscription(Base):
    """Browser push notification subscriptions."""
    __tablename__ = "push_subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    user_email = Column(String(200), nullable=False, index=True)
    endpoint = Column(Text, nullable=False)
    p256dh = Column(String(200), nullable=False)
    auth = Column(String(200), nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    def __repr__(self):
        return f"<PushSubscription(id={self.id}, user='{self.user_email}')>"


class Ticket(Base):
    """Support tickets submitted by users."""
    __tablename__ = "tickets"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(200), nullable=False)
    description = Column(Text, nullable=False)
    category = Column(String(50), nullable=False)  # media_request, playback_issue, account_issue, feature_suggestion, other
    status = Column(String(20), nullable=False, default="open")  # open, in_progress, resolved, closed
    priority = Column(String(20), nullable=True)  # low, medium, high, urgent (admin-only)
    is_public = Column(Boolean, default=False, nullable=False)
    creator_username = Column(String(100), nullable=False, index=True)
    creator_name = Column(String(100), nullable=False)
    # The creator's session email, lower-cased: the identity ticket alerts are
    # sent to. Usernames come from separate namespaces (local, Plex, OIDC) and
    # can collide. Null on tickets created before the column existed.
    creator_email = Column(String(255), nullable=True)
    # The creator's stable account identity, which owns the ticket (see
    # tickets.account_identity): "plex:<Plex account id>" however a Plex
    # account signed in, "local:<users.id>", or "oidc:<subject>". Never the
    # username, which is kept above for display only. Null on tickets created
    # before the column existed until their owner claims them at sign-in.
    creator_identity = Column(String(255), nullable=True, index=True)
    image_path = Column(String(300), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    def __repr__(self):
        return f"<Ticket(id={self.id}, title='{self.title}', status='{self.status}')>"


class TicketComment(Base):
    """Comments on support tickets."""
    __tablename__ = "ticket_comments"

    id = Column(Integer, primary_key=True, index=True)
    ticket_id = Column(Integer, nullable=False, index=True)
    author_username = Column(String(100), nullable=False)
    author_name = Column(String(100), nullable=False)
    # The author's account identity, as Ticket.creator_identity.
    author_identity = Column(String(255), nullable=True)
    is_admin = Column(Boolean, default=False, nullable=False)
    message = Column(Text, nullable=False)
    image_path = Column(String(300), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    def __repr__(self):
        return f"<TicketComment(id={self.id}, ticket_id={self.ticket_id})>"


class WikiCategory(Base):
    """One level of grouping for wiki pages. There is no nesting below this."""
    __tablename__ = "wiki_categories"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    slug = Column(String(120), unique=True, nullable=False, index=True)
    description = Column(String(300), nullable=True)
    icon = Column(String(60), nullable=True)  # Material Symbols name
    sort_order = Column(Integer, default=0, nullable=False)

    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    def __repr__(self):
        return f"<WikiCategory(id={self.id}, slug='{self.slug}')>"


class WikiPage(Base):
    """One guide within the wiki."""
    __tablename__ = "wiki_pages"

    id = Column(Integer, primary_key=True, index=True)
    # SET NULL, not CASCADE: deleting a category must never silently delete the
    # guides inside it. Orphans surface in the editor as "Uncategorised".
    # NB: SQLite does not enforce ON DELETE without PRAGMA foreign_keys=ON, which
    # this app does not set, so the delete-category endpoint nulls these
    # explicitly in Python. See app/routers/wiki.py. The declaration stays
    # because it documents intent and is correct on any other backend.
    category_id = Column(
        Integer,
        ForeignKey("wiki_categories.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    title = Column(String(200), nullable=False)
    # The page's public identity. URLs are /wiki/<slug>, never /wiki/<id>, so a
    # link survives a retitle and reads sensibly when pasted to someone.
    slug = Column(String(220), unique=True, nullable=False, index=True)
    summary = Column(String(300), nullable=True)

    content = Column(Text, nullable=False)       # markdown source
    content_html = Column(Text, nullable=False)  # rendered + sanitized on write

    # A wiki is not chronological; a guide does not become more useful because
    # it was edited recently. Order is explicit, title-alphabetical as tiebreak.
    sort_order = Column(Integer, default=0, nullable=False)

    published = Column(Boolean, default=False, nullable=False)
    # Set only on the page shipped with a fresh install, so it can wear a
    # "delete me" banner that operator-authored pages never get. Testing a flag
    # rather than matching the title keeps that working after a rename.
    is_example = Column(Boolean, default=False, nullable=False)

    author_name = Column(String(100), nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    def __repr__(self):
        return f"<WikiPage(id={self.id}, slug='{self.slug}')>"


# ---- Audiobook player ----
# Every row is keyed by the listener's account identity (tickets.account_identity,
# "plex:<id>"), never the username. Queries in app/services/listening.py always
# filter by the session's identity, so a listener only ever sees their own rows.

class ListeningPosition(Base):
    """Where one listener is in one book: the last stored check-in."""
    __tablename__ = "listening_positions"
    # An earlier copy of a re-added book is found by work key (listening.find_linked).
    __table_args__ = (Index("ix_listening_positions_identity_work_key", "identity", "work_key"),)

    # One row per identity and book.
    identity = Column(String(255), primary_key=True)
    book_key = Column(String(64), primary_key=True)
    track_key = Column(String(64), nullable=False)
    offset_ms = Column(Integer, nullable=False)
    duration_ms = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime, nullable=False)   # naive UTC
    device = Column(String(80), nullable=False, default="")
    # The browser's own random id (the label alone can't tell two phones of
    # one kind apart); null from a player that sent none.
    device_id = Column(String(40), nullable=True)
    source = Column(String(10), nullable=False, default="web")   # web, plex, local
    # The page session that wrote the row and its check-in number: an older
    # seq from the same page session never overwrites a newer one.
    psid = Column(String(64), nullable=True)
    seq = Column(Integer, nullable=True)
    # The place in terms that survive the book's files being replaced: ms from
    # the start of the book, the book's length then, that copy's chapter name,
    # its narrator, and a key for the work itself (plex_player.work_key). Null
    # when not known (rows saved before these existed).
    book_ms = Column(Integer, nullable=True)
    book_duration_ms = Column(Integer, nullable=True)
    chapter_label = Column(String(200), nullable=True)
    work_key = Column(String(32), nullable=True)
    narrator = Column(String(200), nullable=True)

    def __repr__(self):
        return f"<ListeningPosition(identity='{self.identity}', book='{self.book_key}')>"


class ListeningLog(Base):
    """Every stored check-in, for the listening history. Pruned after 180 days."""
    __tablename__ = "listening_log"
    __table_args__ = (Index("ix_listening_log_identity_book_at", "identity", "book_key", "at"),)

    id = Column(Integer, primary_key=True)
    identity = Column(String(255), nullable=False)
    book_key = Column(String(64), nullable=False)
    track_key = Column(String(64), nullable=False)
    offset_ms = Column(Integer, nullable=False)
    device = Column(String(80), nullable=False, default="")
    device_id = Column(String(40), nullable=True)
    event = Column(String(16), nullable=False)   # play, pause, checkin, seek, jump, leave, end
    at = Column(DateTime, nullable=False)        # naive UTC
    # As on ListeningPosition.
    book_ms = Column(Integer, nullable=True)
    book_duration_ms = Column(Integer, nullable=True)
    chapter_label = Column(String(200), nullable=True)
    work_key = Column(String(32), nullable=True)
    narrator = Column(String(200), nullable=True)

    def __repr__(self):
        return f"<ListeningLog(id={self.id}, event='{self.event}')>"


class PlayerPrefs(Base):
    """One listener's player preferences. No row means the defaults."""
    __tablename__ = "player_prefs"

    identity = Column(String(255), primary_key=True)
    skip_s = Column(Integer, nullable=False, default=10)
    speed = Column(Float, nullable=False, default=1.0)
    smart_rewind = Column(Boolean, nullable=False, default=True)

    def __repr__(self):
        return f"<PlayerPrefs(identity='{self.identity}')>"
