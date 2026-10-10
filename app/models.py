"""
Database models for WebServarr.
"""

from sqlalchemy import CheckConstraint, Column, Date, Integer, String, Text, Boolean, DateTime, Enum, Float, ForeignKey, Index, UniqueConstraint
from sqlalchemy.sql import func, text
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
    """One item of the status feed (app/services/status_feed.py): an outage
    Uptime Kuma reported (source "auto"), an admin's note ("admin") or a
    library event ("library"): a Sonarr, Radarr or Chaptarr webhook, a
    request, an issue n8n fixed or a Kometa run.

    `message` holds the line people read; `title` is its first 200
    characters. An outage is one row: opened as "<Service> is down", closed
    as "<Service> is back, down <duration>". The columns from `source` on
    are added to older databases by seed.migrate_status_feed_fields."""
    __tablename__ = "status_updates"
    # At most one open outage per monitor, whichever worker records it.
    __table_args__ = (
        Index("ux_status_updates_open_monitor", "monitor_id", unique=True,
              sqlite_where=text("active = 1 AND source = 'auto'")),
        # Each library event is written once, whichever worker takes it.
        Index("ux_status_updates_event_key", "event_key", unique=True,
              sqlite_where=text("event_key IS NOT NULL")),
    )

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(200), nullable=False)
    message = Column(Text, nullable=False)

    # Type of update
    update_type = Column(String(20), nullable=False)  # incident, maintenance, resolved, note
    severity = Column(String(20), nullable=False)  # info, warning, critical

    # Associated service (optional): the monitor's name for an outage
    service_name = Column(String(100), nullable=True)

    # Metadata
    author_id = Column(String(100), nullable=False)
    author_name = Column(String(100), nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    # Status
    active = Column(Boolean, default=True, nullable=False)
    resolved_at = Column(DateTime, nullable=True)

    source = Column(String(10), nullable=False, default="admin", server_default="admin")  # auto, admin, library
    important = Column(Boolean, nullable=False, default=False, server_default=text("0"))
    monitor_id = Column(Integer, nullable=True)  # the Uptime Kuma monitor, for an outage
    started_at = Column(DateTime, nullable=True)  # when the outage began
    ended_at = Column(DateTime, nullable=True)  # when it was seen back up
    pushed_at = Column(DateTime, nullable=True)  # set once, when its push is claimed
    app = Column(String(10), nullable=True)  # a library event's app: sonarr, radarr, chaptarr, requests, n8n, kometa
    event_key = Column(String(160), nullable=True)  # a library event's id (library_lines.LibraryEvent.key)
    # A Sonarr per-file import held back for its Import Complete: not shown.
    pending = Column(Boolean, nullable=False, default=False, server_default=text("0"))

    def __repr__(self):
        return f"<StatusUpdate(id={self.id}, type='{self.update_type}')>"


class StatusEventRef(Base):
    """A request the event log has dealt with (status_feed.record_request),
    keyed "seerr-request:<id>" or "book-request:<book>:<format>": inserted
    first, so it is written once whichever worker or poller sees it.
    `line_id` is the line it counts toward (a burst folds several into
    one). Deleted with the lines, after 30 days."""
    __tablename__ = "status_event_refs"

    key = Column(String(160), primary_key=True)
    line_id = Column(Integer, nullable=True, index=True)
    seen_at = Column(DateTime, nullable=False)                      # naive UTC

    def __repr__(self):
        return f"<StatusEventRef(key='{self.key}', line_id={self.line_id})>"


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


class AccessRequest(Base):
    """A stranger's request for access from the sign-in page, one row per Plex
    account (docs/superpowers/specs/2026-10-10-request-access-design.md,
    section 4). The Plex account id is the key for "one open request" and
    for the cooldown. The requester's Plex token is never stored anywhere.
    app/services/access_requests.py owns the rules."""

    __tablename__ = "access_requests"

    id = Column(Integer, primary_key=True, index=True)
    plex_account_id = Column(String(32), unique=True, nullable=False)
    plex_username = Column(String(100), nullable=False)
    plex_email = Column(String(254), nullable=False, default="", server_default="")
    plex_avatar_url = Column(String(500), nullable=False, default="", server_default="")
    name = Column(String(80), nullable=False)
    note = Column(Text, nullable=False)
    status = Column(String(10), nullable=False, index=True)    # pending, approved, denied, blocked
    share_state = Column(String(10), nullable=True)             # shared, existing, failed (set on approve)
    share_error = Column(String(200), nullable=True)            # Plex's short reason when failed, never a token
    library_keys = Column(Text, nullable=True)                  # JSON list of the section keys ticked on approve
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    decided_at = Column(DateTime, nullable=True)
    decided_by = Column(String(64), nullable=True)              # the admin's tickets.account_identity
    cooldown_until = Column(DateTime, nullable=True)            # denied: decided_at plus 30 days


class AdminContact(Base):
    """Where an admin's notices go (spec 2026-10-10-request-access-design.md,
    section 8): the Plex account id that made a session admin, and the email
    its bell and push are filed under (utils.identity_email of the session's
    email). The admin is found by this account id, never by comparing
    emails. app/services/admin_contacts.py owns it."""

    __tablename__ = "admin_contacts"

    plex_account_id = Column(String(32), primary_key=True)
    notify_email = Column(String(200), primary_key=True)
    seen_at = Column(DateTime, nullable=False)


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
    # The book key of the earlier copy this place was carried over from (a
    # book re-added as a new album), so its history stays with the book.
    linked_from = Column(String(64), nullable=True)
    # The book's title as the library showed it at the last check-in that
    # could read it, so a place offered from this copy can say which copy it
    # was. Null when not known.
    book_title = Column(String(300), nullable=True)
    # The book's author as the library named them (spec 2.6 s3), so a place
    # whose album is gone can be offered first to a book by the same author.
    # Null when not known.
    author = Column(String(200), nullable=True)
    # True when linked_from was chosen by the listener from "Were you
    # listening to one of these?" rather than found by work key (spec 2.6
    # s3); null for an automatic link or none.
    link_manual = Column(Boolean, nullable=True)

    def __repr__(self):
        return f"<ListeningPosition(identity='{self.identity}', book='{self.book_key}')>"


class ListeningClaim(Base):
    """One listener's claim that `holder_key` is the book an earlier copy
    (`earlier_key`, gone from the library) became (spec 2.6 s4). The key is
    (identity, earlier_key), so SQLite itself lets only one book hold an
    earlier copy, however two workers race. Written by the check-in that
    carries linked_from: "verified", or "pending" while Plex can't confirm
    it. Released when the holder's row is deleted or no longer holds it, or
    its album is gone when another copy claims it (listening.claim_link)."""
    __tablename__ = "listening_claims"

    identity = Column(String(255), primary_key=True)
    earlier_key = Column(String(64), primary_key=True)
    holder_key = Column(String(64), nullable=False)
    state = Column(String(10), nullable=False)      # verified, pending
    claimed_at = Column(DateTime, nullable=False)   # naive UTC
    # The claim was chosen by the listener (a manual link), not found by work
    # key; kept so a pending claim that verifies later still says so.
    manual = Column(Boolean, nullable=True)

    def __repr__(self):
        return f"<ListeningClaim(identity='{self.identity}', earlier='{self.earlier_key}')>"


class ListeningDismissal(Base):
    """The listener answered "None of these" to "Were you listening to one of
    these?" for `book_key` (spec 2.6 s3). One row per identity and book, so it
    holds on every device; the question is never asked for that book again."""
    __tablename__ = "listening_dismissals"

    identity = Column(String(255), primary_key=True)
    book_key = Column(String(64), primary_key=True)
    dismissed_at = Column(DateTime, nullable=False)   # naive UTC

    def __repr__(self):
        return f"<ListeningDismissal(identity='{self.identity}', book='{self.book_key}')>"


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


class Book(Base):
    """One work in the Books catalog: an ebook (Kavita), its audiobook editions
    (Plex, one or several narrations) or both as one entry. Rebuilt from the two sources by
    app/services/book_catalog.py; nothing per person is kept here.

    A row keeps its id while its Kavita chapter id or Plex key is unchanged. When two
    rows become one, the losing row stays with merged_into set to the
    survivor, so an old link still finds the book, and a later split revives
    it. Only rows with merged_into null are live books."""
    __tablename__ = "books"
    __table_args__ = (
        Index("ix_books_kavita_chapter_id", "kavita_chapter_id"),
        Index("ix_books_plex_book_key", "plex_book_key"),
        Index("ix_books_merged_into", "merged_into"),
    )

    id = Column(Integer, primary_key=True)
    work_key = Column(String(32), nullable=True)
    # The ebook's own work key (work_key is the primary edition's when there is
    # one), kept so an ebook held through a Kavita outage is not mistaken for
    # its audiobook.
    ebook_work_key = Column(String(32), nullable=True)
    title = Column(String(300), nullable=False)
    sort_title = Column(String(300), nullable=False, default="")
    author = Column(String(200), nullable=False, default="")
    series = Column(String(200), nullable=False, default="")
    series_number = Column(Float, nullable=True)
    description = Column(Text, nullable=False, default="")
    # The ebook is one book in Kavita: a numbered volume, or a chapter where
    # Kavita keeps a standalone book as one. The chapter is the one that is
    # read (a volume's first) and what the catalog follows; the volume is
    # null for a book that is not a numbered volume.
    kavita_chapter_id = Column(Integer, nullable=True)
    kavita_volume_id = Column(Integer, nullable=True)
    kavita_series_id = Column(Integer, nullable=True)
    kavita_library_id = Column(Integer, nullable=True)
    # The primary audiobook edition (the earliest added): its key, as the
    # player uses it (album or album:disc). The row's text comes from it first.
    # The editions themselves, with their narrators, are in book_audio_editions
    # (narrator lives only there). A retired row (merged_into set) keeps the
    # key it had, so a later split can give it back.
    plex_book_key = Column(String(64), nullable=True)
    added_at = Column(DateTime, nullable=True)                      # naive UTC; the earlier of the two sources
    ebook_added_at = Column(DateTime, nullable=True)
    audio_added_at = Column(DateTime, nullable=True)
    cover_source = Column(String(10), nullable=False, default="plex")   # kavita or plex
    updated_at = Column(DateTime, nullable=False)                   # naive UTC
    merged_into = Column(Integer, nullable=True)

    def __repr__(self):
        return f"<Book(id={self.id}, title='{self.title}')>"


class BookAudioEdition(Base):
    """One audiobook of a Book: a Plex book (album or album:disc) and its
    narrator. A book has none or several; each key is in exactly one book, so
    the player's place for an edition (kept by plex key) stays with it."""
    __tablename__ = "book_audio_editions"
    __table_args__ = (Index("ix_book_audio_editions_book_id", "book_id"),)

    id = Column(Integer, primary_key=True)
    book_id = Column(Integer, nullable=False)
    plex_book_key = Column(String(64), nullable=False, unique=True)
    narrator = Column(String(200), nullable=False, default="")
    work_key = Column(String(32), nullable=True)                    # this edition's own key
    added_at = Column(DateTime, nullable=True)                      # naive UTC

    def __repr__(self):
        return f"<BookAudioEdition(book_id={self.book_id}, key='{self.plex_book_key}')>"


class BookPairOverride(Base):
    """An admin's decision about one Kavita book (its chapter id, see Book)
    and one audiobook edition (its Plex key): `pair` joins that edition to the
    ebook whatever their work keys say, `apart` keeps it out of the ebook's
    book even when the keys match. Always wins, and survives every rebuild."""
    __tablename__ = "book_pair_overrides"
    __table_args__ = (
        UniqueConstraint("kavita_chapter_id", "plex_book_key", name="uq_book_pair_overrides_pair"),
        CheckConstraint("action IN ('pair', 'apart')", name="ck_book_pair_overrides_action"),
    )

    id = Column(Integer, primary_key=True)
    kavita_chapter_id = Column(Integer, nullable=False)
    plex_book_key = Column(String(64), nullable=False)
    action = Column(String(8), nullable=False)
    created_by = Column(String(255), nullable=False, default="")
    created_at = Column(DateTime, nullable=False)                   # naive UTC

    def __repr__(self):
        return f"<BookPairOverride({self.kavita_chapter_id}, '{self.plex_book_key}', '{self.action}')>"


class BookListEntry(Base):
    """One book on one person's My list (app/services/book_personal.py). Kept
    when the book leaves the catalog or the person cannot see it for a while,
    and shown again when it is back; follows a merge (merged_into)."""
    __tablename__ = "book_list"
    __table_args__ = (
        UniqueConstraint("identity", "book_id", name="uq_book_list_identity_book"),
        Index("ix_book_list_book_id", "book_id"),
    )

    id = Column(Integer, primary_key=True)
    identity = Column(String(255), nullable=False)
    book_id = Column(Integer, nullable=False)
    added_at = Column(DateTime, nullable=False)                     # naive UTC

    def __repr__(self):
        return f"<BookListEntry(identity='{self.identity}', book_id={self.book_id})>"


class BookQueueEntry(Base):
    """One book in one person's Up next queue. Positions are dense from 0 per
    identity and unique; every change renumbers the person's whole queue."""
    __tablename__ = "book_queue"
    __table_args__ = (
        UniqueConstraint("identity", "book_id", name="uq_book_queue_identity_book"),
        UniqueConstraint("identity", "position", name="uq_book_queue_identity_position"),
        Index("ix_book_queue_book_id", "book_id"),
    )

    id = Column(Integer, primary_key=True)
    identity = Column(String(255), nullable=False)
    book_id = Column(Integer, nullable=False)
    position = Column(Integer, nullable=False)
    added_at = Column(DateTime, nullable=False)                     # naive UTC

    def __repr__(self):
        return f"<BookQueueEntry(identity='{self.identity}', book_id={self.book_id}, position={self.position})>"


class BookContinueHidden(Base):
    """One book one person took out of their Continue row. Only the row: their
    place in the book (the player's listening_positions, Kavita's progress)
    is never touched, so Resume on the book page still works. `activity_at`
    is the book's newest activity the row showed then (naive UTC, to the
    millisecond the row sends; null for an ebook place Kavita gave no time),
    so the book comes back by itself once they listen or read further. Kept
    while the book is away from the catalog; follows a merge (merged_into)."""
    __tablename__ = "book_continue_hidden"
    __table_args__ = (
        UniqueConstraint("identity", "book_id", name="uq_book_continue_hidden_identity_book"),
        Index("ix_book_continue_hidden_book_id", "book_id"),
    )

    id = Column(Integer, primary_key=True)
    identity = Column(String(255), nullable=False)
    book_id = Column(Integer, nullable=False)
    activity_at = Column(DateTime, nullable=True)                   # naive UTC
    hidden_at = Column(DateTime, nullable=False)                    # naive UTC

    def __repr__(self):
        return f"<BookContinueHidden(identity='{self.identity}', book_id={self.book_id})>"


class BookRating(Base):
    """One person's 1 to 5 star rating of one book: the record the site shows.
    It is also written through to Kavita (the book's chapter rating) and Plex
    (each audiobook edition); each target's state is ok, pending or
    failed:<reason>. A cleared rating keeps its row (stars null) until the
    clear has been written to both, then the row goes. `version` counts
    changes, so a write that finishes after a newer change never marks it
    written; `attempts` and `retry_at` are the retry backoff."""
    __tablename__ = "book_ratings"
    __table_args__ = (
        UniqueConstraint("identity", "book_id", name="uq_book_ratings_identity_book"),
        CheckConstraint("stars IS NULL OR (stars >= 1 AND stars <= 5)", name="ck_book_ratings_stars"),
        Index("ix_book_ratings_book_id", "book_id"),
        Index("ix_book_ratings_retry_at", "retry_at"),
    )

    id = Column(Integer, primary_key=True)
    identity = Column(String(255), nullable=False)
    book_id = Column(Integer, nullable=False)
    stars = Column(Integer, nullable=True)
    updated_at = Column(DateTime, nullable=False)                   # naive UTC
    kavita_state = Column(String(40), nullable=False, default="pending")
    plex_state = Column(String(40), nullable=False, default="pending")
    version = Column(Integer, nullable=False, default=1)
    attempts = Column(Integer, nullable=False, default=0)
    retry_at = Column(DateTime, nullable=True)                      # naive UTC

    def __repr__(self):
        return f"<BookRating(identity='{self.identity}', book_id={self.book_id}, stars={self.stars})>"


# ---- Books discovery (app/services/book_discovery.py) ----
# Keyed by account identity like the rest of Books. Nothing here is ever sent
# to anyone but the person it belongs to, except popularity, which is a count
# per book (never who) and never below book_discovery.POPULAR_MIN.

class BookVisit(Base):
    """When one person last opened Books, and the visit before that (the New
    badges compare against prev_seen_at). `email` is their session's email,
    the address a "New in your series" notification goes to."""
    __tablename__ = "book_visits"

    identity = Column(String(255), primary_key=True)
    email = Column(String(255), nullable=True)
    seen_at = Column(DateTime, nullable=False)                      # naive UTC
    prev_seen_at = Column(DateTime, nullable=True)                  # null until a second visit

    def __repr__(self):
        return f"<BookVisit(identity='{self.identity}')>"


class BookPopularity(Base):
    """How many different people listened to a book lately, recomputed at
    most hourly. Only books at or above the floor have a row."""
    __tablename__ = "book_popularity"

    book_id = Column(Integer, primary_key=True)
    listeners = Column(Integer, nullable=False)
    computed_at = Column(DateTime, nullable=False)                  # naive UTC

    def __repr__(self):
        return f"<BookPopularity(book_id={self.book_id}, listeners={self.listeners})>"


class ListeningDaily(Base):
    """One person's listening on one UTC day, rolled up from listening_log
    before the log is pruned, so all-time totals outlive the log."""
    __tablename__ = "listening_daily"
    __table_args__ = (UniqueConstraint("identity", "day", name="uq_listening_daily_identity_day"),)

    id = Column(Integer, primary_key=True)
    identity = Column(String(255), nullable=False)
    day = Column(Date, nullable=False)
    ms = Column(Integer, nullable=False, default=0)
    books_touched = Column(Integer, nullable=False, default=0)

    def __repr__(self):
        return f"<ListeningDaily(identity='{self.identity}', day={self.day})>"


class BookFollow(Base):
    """One person's choice about one series (book_catalog.name_key of its
    name): followed by hand (`manual`), followed because the Continue row saw
    them reading it (`read`), or unfollowed (`off`), which also stops their
    list and their listening from following it. Following because of My list
    or listening (`list`, `listen`) is worked out when needed, not stored."""
    __tablename__ = "book_follows"
    __table_args__ = (UniqueConstraint("identity", "series", name="uq_book_follows_identity_series"),)

    id = Column(Integer, primary_key=True)
    identity = Column(String(255), nullable=False)
    series = Column(String(255), nullable=False)
    source = Column(String(10), nullable=False)
    created_at = Column(DateTime, nullable=False)                   # naive UTC

    def __repr__(self):
        return f"<BookFollow(identity='{self.identity}', series='{self.series}', source='{self.source}')>"


class BookAnnounced(Base):
    """A catalog book that "New in your series" has already dealt with
    (announced, or passed over silently)."""
    __tablename__ = "book_announced"

    book_id = Column(Integer, primary_key=True)
    announced_at = Column(DateTime, nullable=False)                 # naive UTC

    def __repr__(self):
        return f"<BookAnnounced(book_id={self.book_id})>"


class BookCatalogMeta(Base):
    """How the last rebuild went. One row, id 1."""
    __tablename__ = "book_catalog_meta"

    id = Column(Integer, primary_key=True)
    last_rebuild_at = Column(DateTime, nullable=True)               # naive UTC
    last_ok_at = Column(DateTime, nullable=True)                    # a rebuild that read at least one source
    last_reason = Column(String(40), nullable=True)
    ebook_count = Column(Integer, nullable=False, default=0)
    audiobook_count = Column(Integer, nullable=False, default=0)
    book_count = Column(Integer, nullable=False, default=0)
    kavita_error = Column(String(200), nullable=True)
    plex_error = Column(String(200), nullable=True)

    def __repr__(self):
        return f"<BookCatalogMeta(last_rebuild_at={self.last_rebuild_at})>"


class BookRequestTime(Base):
    """When a Chaptarr book row was last asked for through the Requests page
    (app/services/book_requests.py). Chaptarr's own `added` is when the row
    arrived, which for a book an author import brought in unmonitored can be
    months before anyone asked for it."""
    __tablename__ = "book_request_times"

    book_id = Column(Integer, primary_key=True)                     # Chaptarr's book row id
    requested_at = Column(DateTime, nullable=False)                 # naive UTC

    def __repr__(self):
        return f"<BookRequestTime(book_id={self.book_id})>"
