"""
Seed the database with defaults on first startup.
"""

import logging
import secrets
from sqlalchemy.orm import Session
from app.models import User, Setting
from app.settings_registry import seed_defaults

logger = logging.getLogger(__name__)

# Every operator setting and its shipped default is defined once, in
# app/settings_registry.py. Seeding inserts missing keys only, so an
# operator's customisations survive upgrades.
DEFAULT_SETTINGS = seed_defaults()


def migrate_setup_completed(db: Session) -> None:
    """One-time migration: mark setup as completed for existing installs
    that already have an admin user (pre-wizard upgrades)."""
    from sqlalchemy.exc import IntegrityError

    if db.query(Setting).filter(Setting.key == "setup.completed").first():
        return

    admin_count = db.query(User).filter(User.is_admin == True).count()
    if admin_count > 0:
        db.add(Setting(
            key="setup.completed",
            value="true",
            description="Initial setup wizard has been completed",
        ))
        try:
            db.commit()
            logger.info("Existing install detected — marked setup as completed")
        except IntegrityError:
            db.rollback()


def migrate_ticket_creator_email(db: Session) -> None:
    """One-time migration: add tickets.creator_email to existing databases.

    create_all() only creates missing tables, never missing columns, so an
    install created before the column existed needs it added. Guarded by
    PRAGMA table_info and idempotent; two workers starting together may both
    try, and the loser's "duplicate column" error is ignored.
    """
    from sqlalchemy import text
    from sqlalchemy.exc import OperationalError

    columns = {row[1] for row in db.execute(text("PRAGMA table_info(tickets)"))}
    if not columns or "creator_email" in columns:
        return  # no table yet (create_all makes it with the column) or done
    try:
        db.execute(text("ALTER TABLE tickets ADD COLUMN creator_email VARCHAR(255)"))
        db.commit()
        logger.info("Added tickets.creator_email")
    except OperationalError as exc:
        db.rollback()
        if "duplicate column" not in str(exc).lower():
            raise


def migrate_ticket_identity(db: Session) -> None:
    """One-time migration: add tickets.creator_identity (indexed) and
    ticket_comments.author_identity to existing databases.

    Tickets belong to a stable account identity instead of the username.
    Existing rows keep a null identity until their owner claims them at the
    next sign-in (tickets.claim_legacy_tickets). Guarded by PRAGMA table_info
    and idempotent, like migrate_ticket_creator_email; a worker that loses
    the race to the other one ignores its "duplicate column" error.
    """
    from sqlalchemy import text
    from sqlalchemy.exc import OperationalError

    for table, column in (("tickets", "creator_identity"), ("ticket_comments", "author_identity")):
        columns = {row[1] for row in db.execute(text(f"PRAGMA table_info({table})"))}
        if not columns or column in columns:
            continue  # no table yet (create_all makes it with the column) or done
        try:
            db.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} VARCHAR(255)"))
            db.commit()
            logger.info("Added %s.%s", table, column)
        except OperationalError as exc:
            db.rollback()
            if "duplicate column" not in str(exc).lower():
                raise
    if {row[1] for row in db.execute(text("PRAGMA table_info(tickets)"))}:
        # create_all names the model's index this way; IF NOT EXISTS keeps
        # a fresh install and a second worker quiet.
        db.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_tickets_creator_identity ON tickets (creator_identity)"
        ))
        db.commit()


def migrate_listening_device_id(db: Session) -> None:
    """One-time migration: add device_id to listening_positions and
    listening_log in existing databases.

    The audiobook player's handoff prompt tells devices apart by a random id
    each browser keeps; the device label alone can't (two phones of one
    kind share it). Existing rows keep a null id, which the player reads as
    "compare the labels". Guarded by PRAGMA table_info and idempotent, like
    migrate_ticket_identity; a worker that loses the race to the other one
    ignores its "duplicate column" error.
    """
    from sqlalchemy import text
    from sqlalchemy.exc import OperationalError

    for table in ("listening_positions", "listening_log"):
        columns = {row[1] for row in db.execute(text(f"PRAGMA table_info({table})"))}
        if not columns or "device_id" in columns:
            continue  # no table yet (create_all makes it with the column) or done
        try:
            db.execute(text(f"ALTER TABLE {table} ADD COLUMN device_id VARCHAR(40)"))
            db.commit()
            logger.info("Added %s.device_id", table)
        except OperationalError as exc:
            db.rollback()
            if "duplicate column" not in str(exc).lower():
                raise


# The place in terms that survive a book's files being replaced (spec 2.5 s3).
LISTENING_BOOK_COLUMNS = (
    ("book_ms", "INTEGER"),
    ("book_duration_ms", "INTEGER"),
    ("chapter_label", "VARCHAR(200)"),
    ("work_key", "VARCHAR(32)"),
    ("narrator", "VARCHAR(200)"),
)
# And on listening_positions only: the earlier copy a place was carried over from,
# the book's author and whether the link was the listener's own choice.
LISTENING_POSITION_COLUMNS = (("linked_from", "VARCHAR(64)"), ("book_title", "VARCHAR(300)"),
                              ("author", "VARCHAR(200)"), ("link_manual", "BOOLEAN"))
# And on listening_claims only (spec 2.6 s3): whether the claim is a manual link.
LISTENING_CLAIM_COLUMNS = (("manual", "BOOLEAN"),)


def migrate_listening_book_fields(db: Session) -> None:
    """One-time migration: add the book-time, book-length, chapter, work-key
    and narrator columns to listening_positions and listening_log,
    listening_positions.linked_from, .book_title, .author and .link_manual,
    listening_claims.manual, and the (identity, work_key) index an
    earlier copy of a re-added book is found by, in existing databases.
    (listening_dismissals is a new table: create_all makes it.)

    Existing rows keep nulls (the player treats them as saved before these
    existed). Guarded by PRAGMA table_info and idempotent, like
    migrate_listening_device_id: a worker that loses the race to the other
    one ignores its "duplicate column" error, and the index is created with
    IF NOT EXISTS.
    """
    from sqlalchemy import text
    from sqlalchemy.exc import OperationalError

    wanted = (("listening_positions", LISTENING_BOOK_COLUMNS + LISTENING_POSITION_COLUMNS),
              ("listening_log", LISTENING_BOOK_COLUMNS),
              ("listening_claims", LISTENING_CLAIM_COLUMNS))
    for table, new_columns in wanted:
        columns = {row[1] for row in db.execute(text(f"PRAGMA table_info({table})"))}
        if not columns:
            continue  # no table yet: create_all makes it with the columns and the index
        for name, kind in new_columns:
            if name in columns:
                continue
            try:
                db.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {kind}"))
                db.commit()
                logger.info("Added %s.%s", table, name)
            except OperationalError as exc:
                db.rollback()
                if "duplicate column" not in str(exc).lower():
                    raise
        if table == "listening_positions":
            db.execute(text("CREATE INDEX IF NOT EXISTS ix_listening_positions_identity_work_key "
                            "ON listening_positions (identity, work_key)"))
            db.commit()


def migrate_books_ebook_unit_v1(db: Session) -> None:
    """One-time migration for databases that made the Books catalog tables
    while its ebook unit was a whole Kavita series: books and
    book_pair_overrides are remade, because the ebook is now one book (a
    chapter id, see app/models.py Book) and SQLite can't change a NOT NULL
    key column in place. The catalog is rebuilt from Kavita and Plex at the
    next rebuild; the overrides table could hold nothing yet (no route wrote
    to it before this change). Guarded by PRAGMA table_info, so it does
    nothing on a fresh database or a second run; with two workers starting at
    once, a worker that sees the new columns leaves the tables alone, and the
    drop is IF EXISTS.
    """
    from sqlalchemy import text

    columns = {row[1] for row in db.execute(text("PRAGMA table_info(books)"))}
    if not columns or "kavita_chapter_id" in columns:
        return
    for table in ("book_pair_overrides", "books"):
        db.execute(text(f"DROP TABLE IF EXISTS {table}"))
    db.commit()
    from app.database import create_tables
    create_tables(db.get_bind())
    logger.info("Remade the Books catalog tables for one ebook per book")


LISTENING_CLAIMS_MARKER = "migration.listening_claims_v1"


def migrate_listening_claims(db: Session) -> None:
    """One-time migration: give every earlier-copy link the listening rows
    already hold its claim (spec 2.6 s4: one successor per earlier copy).

    create_all makes the listening_claims table; this fills it from
    listening_positions.linked_from, as verified claims. Where two rows hold
    the same earlier copy (the race the claims close), the newer row gets
    the claim; the other keeps its link for its history. Idempotent and
    safe with two workers: the back-fill is the transaction's first
    statement (a write, so SQLite's write lock is taken before anything is
    decided) and an INSERT OR IGNORE, and the marker is written in the same
    commit; a worker that loses the race to it rolls back.
    """
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    for table in ("listening_claims", "listening_positions", "settings"):
        if not list(db.execute(text(f"PRAGMA table_info({table})"))):
            return  # no tables yet: create_all makes them (and there is nothing to fill)
    if _setting_row(db, LISTENING_CLAIMS_MARKER):
        return
    filled = db.execute(text(
        "INSERT OR IGNORE INTO listening_claims (identity, earlier_key, holder_key, state, claimed_at) "
        "SELECT identity, linked_from, book_key, 'verified', updated_at FROM listening_positions "
        "WHERE linked_from IS NOT NULL AND linked_from != book_key "
        "ORDER BY updated_at DESC, book_key"
    )).rowcount
    db.add(Setting(key=LISTENING_CLAIMS_MARKER, value="done",
                   description="One-time claims for the earlier-copy links listening rows held"))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()  # the other worker ran it first
        return
    logger.info("Gave %d earlier-copy link(s) their claim", filled)


def migrate_user_uid(db: Session) -> None:
    """One-time migration: add users.uid (unique) and give every existing
    user a permanent random one.

    A local account owns its tickets as "local:<uid>". users.id cannot be
    that identity: the table has no AUTOINCREMENT, so SQLite hands a deleted
    top row's id to the next user. New users get a uid from the model's
    default. Idempotent and safe with two workers: the column add ignores
    "duplicate column", and each backfill only fills a still-empty uid, so a
    uid the other worker wrote first is never replaced.
    """
    import uuid
    from sqlalchemy import text
    from sqlalchemy.exc import OperationalError

    columns = {row[1] for row in db.execute(text("PRAGMA table_info(users)"))}
    if not columns:
        return  # no table yet: create_all makes it with the column
    if "uid" not in columns:
        try:
            db.execute(text("ALTER TABLE users ADD COLUMN uid VARCHAR(36)"))
            db.commit()
            logger.info("Added users.uid")
        except OperationalError as exc:
            db.rollback()
            if "duplicate column" not in str(exc).lower():
                raise
    db.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_uid ON users (uid)"))
    db.commit()
    missing = [row[0] for row in db.execute(text("SELECT id FROM users WHERE uid IS NULL"))]
    for user_id in missing:
        db.execute(
            text("UPDATE users SET uid = :uid WHERE id = :id AND uid IS NULL"),
            {"uid": str(uuid.uuid4()), "id": user_id},
        )
    if missing:
        db.commit()
        logger.info("Gave %d existing user(s) a permanent uid", len(missing))


# The local usernames that existed when ticket identities arrived. A Plex
# account never claims a legacy ticket by a username on this list (or in the
# users table now): the ticket may be the local account's.
LOCAL_USERNAMES_SNAPSHOT_KEY = "migration.ticket_local_usernames_v1"


def migrate_local_usernames_snapshot(db: Session) -> None:
    """One-time: record every local username, so a local account renamed or
    removed after the upgrade still blocks a Plex namesake from claiming its
    legacy tickets by username (tickets.claim_legacy_tickets). The row is
    both the marker and the snapshot; the worker that loses the race to
    write it rolls back."""
    import json
    from sqlalchemy.exc import IntegrityError

    if db.query(Setting).filter(Setting.key == LOCAL_USERNAMES_SNAPSHOT_KEY).first():
        return
    names = sorted({u for (u,) in db.query(User.username).all() if u})
    db.add(Setting(key=LOCAL_USERNAMES_SNAPSHOT_KEY, value=json.dumps(names),
                   description="Local usernames when ticket identities arrived"))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()  # the other worker ran it first


def migrate_drop_push_username_rows(db: Session) -> None:
    """One-time migration: delete push.user.<hash>.email settings rows.

    A dev build mapped usernames to emails there for ticket alerts. Usernames
    from different sign-in methods can collide, so that mapping could send
    one person's ticket alerts to another; tickets now store the creator's
    email instead. Idempotent.

    Guarded by migration.drop_push_username_rows_v1, written in the same
    commit, so the scan runs on the first start only.
    """
    from sqlalchemy.exc import IntegrityError

    marker = "migration.drop_push_username_rows_v1"
    if db.query(Setting).filter(Setting.key == marker).first():
        return
    removed = (
        db.query(Setting)
        .filter(Setting.key.like("push.user.%.email"))
        .delete(synchronize_session=False)
    )
    db.add(Setting(key=marker, value="done", description="One-time removal of push.user.*.email rows"))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()  # the other worker ran it first
        return
    if removed:
        logger.info("Removed %d push.user.*.email setting row(s)", removed)


def migrate_no_email_identity(db: Session) -> None:
    """One-time migration: drop data filed under the fake "none" identity.

    Sessions used to store a missing email as the string "None", so every
    account without an email (Plex managed users, OIDC identities with no
    email claim) shared one identity: notifications, push subscriptions,
    preferences and ticket creator_email. Those rows cannot be attributed to
    anyone, so they are removed (a ticket just loses its creator_email).
    Idempotent.

    Guarded by migration.no_email_identity_v1, written in the same commit, so
    the full-table scans run on the first start only.
    """
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError
    from app.routers.notifications import _email_hash

    marker = "migration.no_email_identity_v1"
    if db.query(Setting).filter(Setting.key == marker).first():
        return
    db.execute(text("DELETE FROM push_subscriptions WHERE lower(trim(user_email)) IN ('none', '')"))
    db.execute(text("DELETE FROM notifications WHERE lower(trim(user_email)) IN ('none', '')"))
    db.execute(text("UPDATE tickets SET creator_email = NULL WHERE lower(trim(creator_email)) IN ('none', '')"))
    prefix = f"notify.{_email_hash('none')}."
    db.query(Setting).filter(Setting.key.like(prefix + "%")).delete(synchronize_session=False)
    db.add(Setting(key=marker, value="done", description="One-time removal of data filed under no email"))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()  # the other worker ran it first


def seed_default_settings(db: Session) -> None:
    """Insert default branding/theme settings if they don't exist.
    Uses per-key commits to handle race conditions with multiple workers."""
    from sqlalchemy.exc import IntegrityError

    added = 0
    for key, (value, description) in DEFAULT_SETTINGS.items():
        existing = db.query(Setting).filter(Setting.key == key).first()
        if existing:
            continue
        try:
            db.add(Setting(key=key, value=value, description=description))
            db.commit()
            added += 1
        except IntegrityError:
            db.rollback()  # Another worker already inserted it

    if added:
        logger.info("Seeded %d default branding/theme settings", added)


def seed_vapid_keys(db: Session) -> None:
    """Generate and store VAPID key pair for Web Push notifications.
    Skips if keys already exist. Handles pywebpush not being installed."""
    from sqlalchemy.exc import IntegrityError

    # Check if public key already exists — if so, nothing to do
    existing = db.query(Setting).filter(
        Setting.key == "notifications.vapid_public_key"
    ).first()
    if existing:
        return

    try:
        from py_vapid import Vapid
        from py_vapid.utils import b64urlencode
        from cryptography.hazmat.primitives import serialization
    except ImportError:
        logger.warning(
            "pywebpush not installed — skipping VAPID key generation. "
            "Install pywebpush>=2.0.0 to enable push notifications."
        )
        return

    # Generate a new ECDSA key pair
    vapid = Vapid()
    vapid.generate_keys()

    # Export public key as URL-safe base64 (uncompressed point, no padding)
    public_key_b64 = b64urlencode(
        vapid.public_key.public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint,
        )
    )

    # Export private key as PEM string
    private_key_pem = vapid.private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")

    # Store both keys in Settings
    try:
        db.add(Setting(
            key="notifications.vapid_public_key",
            value=public_key_b64,
            description="VAPID public key for Web Push (auto-generated)",
        ))
        db.add(Setting(
            key="notifications.vapid_private_key",
            value=private_key_pem,
            description="VAPID private key for Web Push (auto-generated, keep secret)",
        ))
        db.commit()
        logger.info("Generated and stored VAPID key pair for Web Push notifications")
    except IntegrityError:
        db.rollback()  # Another worker already generated keys
        logger.debug("VAPID keys already exist (race condition), skipping")


def seed_secret_key(db: Session) -> str:
    """Auto-generate SECRET_KEY on first startup and store in Settings."""
    from sqlalchemy.exc import IntegrityError

    existing = db.query(Setting).filter(Setting.key == "system.secret_key").first()
    if existing:
        return existing.value

    key = secrets.token_hex(32)
    setting = Setting(
        key="system.secret_key",
        value=key,
        description="Auto-generated secret key for session signing",
    )
    db.add(setting)
    try:
        db.commit()
        logger.info("Generated and stored secret key for session signing")
    except IntegrityError:
        db.rollback()
        existing = db.query(Setting).filter(Setting.key == "system.secret_key").first()
        return existing.value if existing else key
    return key


def seed_default_news(db: Session) -> None:
    """Seed default news posts for fresh installs. Guarded by migration marker."""
    from sqlalchemy.exc import IntegrityError
    from app.models import NewsPost
    from app.content import render_markdown
    from datetime import datetime, timezone

    if db.query(Setting).filter(Setting.key == "seed.default_news_v1").first():
        return

    now = datetime.now(timezone.utc)

    posts = [
        {
            "title": "Welcome to WebServarr",
            "content": (
                "## Welcome to WebServarr\n\n"
                "WebServarr is your self-hosted media server portal. Here's what you can do:\n\n"
                "- **Plex Streams** — Monitor active streams and playback quality in real time\n"
                "- **Service Health** — Status tiles powered by Uptime Kuma\n"
                "- **System Gauges** — CPU, RAM, and network stats from Netdata\n"
                "- **Media Requests** — Search and request movies and TV shows via Seerr\n"
                "- **Release Calendar** — Upcoming movies and episodes from Radarr and Sonarr\n"
                "- **Notifications** — In-app and browser push notifications\n"
                "- **Theme Engine** — Colors, fonts, logos, and custom CSS\n\n"
                "Head to **Settings** to connect your integrations and get started."
            ),
            "pinned": True,
        },
        {
            "title": "[Example] Server Maintenance Notice",
            "content": (
                "> **Note:** This is an example post showing news formatting. "
                "Edit or delete it from the **News** page.\n\n"
                "We will be performing routine maintenance on **Saturday** from 2:00 AM to 4:00 AM.\n\n"
                "**Services affected:**\n\n"
                "- Media streaming (Plex)\n"
                "- Media requests (Seerr)\n\n"
                "Expected downtime: ~30 minutes. Thank you for your patience!"
            ),
            "pinned": False,
        },
    ]

    for post_data in posts:
        content_html = render_markdown(post_data["content"])
        post = NewsPost(
            title=post_data["title"],
            content=post_data["content"],
            content_html=content_html,
            author_id="system",
            author_name="WebServarr",
            published=True,
            published_at=now,
            pinned=post_data["pinned"],
        )
        db.add(post)

    db.add(Setting(
        key="seed.default_news_v1",
        value="done",
        description="Default news posts have been seeded",
    ))

    try:
        db.commit()
        logger.info("Seeded %d default news posts", len(posts))
    except IntegrityError:
        db.rollback()
        logger.debug("Default news already seeded (race condition), skipping")


def seed_wiki_example(db: Session) -> None:
    """Seed the single example wiki page on a fresh install.

    Guarded by a marker key rather than by checking whether the page exists: an
    existence check would resurrect the page on the next restart after the
    operator deletes it, which is the opposite of what deleting it means.
    """
    from sqlalchemy.exc import IntegrityError
    from app.content import render_markdown
    from app.models import WikiPage

    if db.query(Setting).filter(Setting.key == "seed.wiki_example_v1").first():
        return

    content = (
        "This page is an example shipped with WebServarr. Edit it, or delete it, "
        "from the **Edit this page** button above.\n\n"
        "## Writing a page\n\n"
        "Wiki pages are written in Markdown. Headings like the one above become "
        "entries in the **On this page** list, so a longer guide stays easy to "
        "skim.\n\n"
        "- Use bullet lists for steps a reader follows in order\n"
        "- Use **bold** for the thing they should click\n"
        "- Link to another wiki page with `[its title](/wiki/its-slug)`\n\n"
        "## Adding pictures and code\n\n"
        "Drop an image into the editor to upload it. Images are only visible to "
        "signed-in users, the same as the rest of the wiki.\n\n"
        "For anything that should be typed exactly, use a code block:\n\n"
        "```\n"
        "one exact thing to type\n"
        "```\n\n"
        "## Organising the wiki\n\n"
        "Group related pages into categories with **Manage categories** on the "
        "wiki index. Pages without a category still show up on the wiki index under "
        "\"Uncategorised\", so nothing gets lost while you decide.\n\n"
        "This page has three headings, which is why the **On this page** list "
        "appears beside it. Shorter pages do not get one."
    )

    page = WikiPage(
        title="Welcome to the Wiki",
        slug="welcome-to-the-wiki",
        summary="How to write, organise and link wiki pages.",
        content=content,
        content_html=render_markdown(content),
        category_id=None,
        sort_order=0,
        published=True,
        is_example=True,
        author_name="WebServarr",
    )
    db.add(page)
    db.add(Setting(
        key="seed.wiki_example_v1",
        value="done",
        description="Example wiki page has been seeded",
    ))

    try:
        db.commit()
        logger.info("Seeded the example wiki page")
    except IntegrityError:
        db.rollback()
        logger.debug("Example wiki page already seeded (race condition), skipping")


def migrate_requests_rename(db: Session) -> None:
    """One-time migration: rename requests2 settings keys to match the
    requests/requests-embed URL rename.
    Guarded by migration.requests_rename_v1 marker."""
    from sqlalchemy.exc import IntegrityError

    if db.query(Setting).filter(Setting.key == "migration.requests_rename_v1").first():
        return

    # Rename order matters: move the old iframe keys out first, then move native keys in.
    renames = [
        # Old iframe keys → new embed keys
        ("sidebar.label_requests", "sidebar.label_requests_embed"),
        ("icon.nav_requests", "icon.nav_requests_embed"),
        # Old native keys → new primary keys
        ("sidebar.label_requests2", "sidebar.label_requests"),
        ("icon.nav_requests2", "icon.nav_requests"),
    ]

    for old_key, new_key in renames:
        row = db.query(Setting).filter(Setting.key == old_key).first()
        if row:
            # Delete any existing row at the target key to avoid unique constraint
            existing_target = db.query(Setting).filter(Setting.key == new_key).first()
            if existing_target:
                db.delete(existing_target)
            row.key = new_key
            db.flush()

    db.add(Setting(
        key="migration.requests_rename_v1",
        value="done",
        description="One-time requests2 → requests-embed rename migration",
    ))

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        logger.debug("migration.requests_rename_v1 marker already exists (race), skipping")
        return

    logger.info("Completed one-time requests rename migration")


def migrate_nav_sublabels_v2(db: Session) -> None:
    """
    One-time migration: undo the v1.7.0 nav rename and reword the two sublabels.

    v1.7.0 replaced the "Issues"/"Tickets" labels with "Report a Problem" and
    "Contact Support" to make the pair self-explanatory. It worked, but only for
    those two entries -- the other six nav items kept bare one-word labels, so
    the list read as half-finished and the two long labels looked out of place.

    The clearer split turned out to belong in the sublabel, not the label: every
    item now keeps a short noun as its name and gains a verb phrase underneath,
    written in one voice across the whole nav. So the labels go back.

    Conditional on the stored value still being exactly what v1.7.0 shipped. A
    label the admin has since chosen is left alone -- this reverts a default, it
    does not overwrite anyone's wording. The six sublabels that have no row yet
    are handled by seed_default_settings, which inserts them with the new text.

    Guarded by migration.nav_sublabels_v2.
    """
    from sqlalchemy.exc import IntegrityError

    if db.query(Setting).filter(Setting.key == "migration.nav_sublabels_v2").first():
        return

    # (key, the exact value v1.7.0 shipped, what it becomes)
    upgrades = [
        ("sidebar.label_issues", "Report a Problem", "Issues"),
        ("sidebar.label_tickets", "Contact Support", "Tickets"),
        ("icon.nav_tickets", "support_agent", "confirmation_number"),
        ("sidebar.sublabel_issues", "Issue with a movie or show", "Report a problem with media"),
        ("sidebar.sublabel_tickets", "Everything else", "Get help from the admin"),
    ]
    changed = []
    for key, old_value, new_value in upgrades:
        row = db.query(Setting).filter(Setting.key == key).first()
        if row and (row.value or "").strip() == old_value:
            row.value = new_value
            changed.append(key)

    db.add(Setting(
        key="migration.nav_sublabels_v2",
        value="done",
        description="One-time revert of the v1.7.0 nav label rename, plus sublabel rewording",
    ))

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        logger.debug("migration.nav_sublabels_v2 marker already exists (race), skipping")
        return

    if changed:
        logger.info("Completed nav sublabel migration (updated: %s)", ", ".join(changed))
    else:
        logger.info("Nav sublabel migration: nothing to change (labels are customised)")


def migrate_wiki_sublabel_v4(db: Session) -> None:
    """
    One-time migration: the Wiki sublabel becomes a verb phrase like the rest.

    Every other nav sublabel starts with a verb -- "Request a movie or show",
    "Report a problem with media", "Read books in your browser". Wiki shipped
    with "Guides and how-tos", a noun phrase, which is the exact inconsistency
    the sublabels were introduced to remove: a list that changes voice partway
    down reads as unfinished.

    Conditional on the stored value as always, so an admin who has since written
    their own keeps it.

    Guarded by migration.wiki_sublabel_v4.
    """
    from sqlalchemy.exc import IntegrityError

    if db.query(Setting).filter(Setting.key == "migration.wiki_sublabel_v4").first():
        return

    row = db.query(Setting).filter(Setting.key == "sidebar.sublabel_wiki").first()
    changed = False
    if row and (row.value or "").strip() == "Guides and how-tos":
        row.value = "Read guides and how-tos"
        changed = True

    db.add(Setting(
        key="migration.wiki_sublabel_v4",
        value="done",
        description="One-time Wiki sublabel rewording to match the nav's verb-phrase voice",
    ))

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        logger.debug("migration.wiki_sublabel_v4 marker already exists (race), skipping")
        return

    logger.info("Wiki sublabel migration: %s", "updated" if changed else "nothing to change (customised)")


def migrate_home_sublabel_v3(db: Session) -> None:
    """
    One-time migration: Home's sublabel becomes "See what's happening".

    "See what's playing" implied the page was only about active streams. The
    homepage also carries news, service health, system gauges and upcoming
    releases, so the wider phrasing describes what is actually there.

    Conditional on the stored value, as always -- an admin who wrote their own
    keeps it. Installs with no row yet get the new text from
    seed_default_settings instead.

    Guarded by migration.home_sublabel_v3.
    """
    from sqlalchemy.exc import IntegrityError

    if db.query(Setting).filter(Setting.key == "migration.home_sublabel_v3").first():
        return

    row = db.query(Setting).filter(Setting.key == "sidebar.sublabel_home").first()
    changed = False
    if row and (row.value or "").strip() == "See what's playing":
        row.value = "See what's happening"
        changed = True

    db.add(Setting(
        key="migration.home_sublabel_v3",
        value="done",
        description="One-time Home sublabel rewording",
    ))

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        logger.debug("migration.home_sublabel_v3 marker already exists (race), skipping")
        return

    logger.info("Home sublabel migration: %s", "updated" if changed else "nothing to change (customised)")


def migrate_overseerr_to_seerr(db: Session) -> None:
    """One-time migration: rename integration.overseerr.* setting keys to
    integration.seerr.* and notifications.poll_interval_overseerr to
    notifications.poll_interval_seerr for existing installs.
    Guarded by migration.overseerr_to_seerr_v1 marker."""
    from sqlalchemy.exc import IntegrityError

    if db.query(Setting).filter(Setting.key == "migration.overseerr_to_seerr_v1").first():
        return

    renames = [
        ("integration.overseerr.url", "integration.seerr.url"),
        ("integration.overseerr.api_key", "integration.seerr.api_key"),
        ("notifications.poll_interval_overseerr", "notifications.poll_interval_seerr"),
    ]

    renamed = 0
    for old_key, new_key in renames:
        row = db.query(Setting).filter(Setting.key == old_key).first()
        if row:
            # Delete any existing row at the target key to avoid unique constraint
            existing_target = db.query(Setting).filter(Setting.key == new_key).first()
            if existing_target:
                db.delete(existing_target)
            row.key = new_key
            db.flush()
            renamed += 1

    # Also update the description on features.show_requests if it references Overseerr
    show_req = db.query(Setting).filter(Setting.key == "features.show_requests").first()
    if show_req and "Overseerr" in (show_req.description or ""):
        show_req.description = show_req.description.replace("Overseerr", "Seerr")

    db.add(Setting(
        key="migration.overseerr_to_seerr_v1",
        value="done",
        description="One-time migration: renamed overseerr setting keys to seerr",
    ))

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        logger.debug("migration.overseerr_to_seerr_v1 marker already exists (race), skipping")
        return

    if renamed:
        logger.info("Completed Overseerr -> Seerr migration: renamed %d setting keys", renamed)
    else:
        logger.info("Completed Overseerr -> Seerr migration: no old keys found")


def _setting_row(db: Session, key: str):
    return db.query(Setting).filter(Setting.key == key).first()


def _finish_migration(db: Session, marker: str, description: str) -> bool:
    """Add the marker and commit. False when another worker got there first."""
    from sqlalchemy.exc import IntegrityError

    db.add(Setting(key=marker, value="done", description=description))
    try:
        db.commit()
        return True
    except IntegrityError:
        db.rollback()
        logger.debug("%s marker already exists (race), skipping", marker)
        return False


def _merge_page_switch(db: Session, marker: str, flag_key: str, switch_key: str, what: str) -> None:
    """Fold an old feature flag into the page's one switch: switch := switch AND flag.

    Only a flag explicitly stored as "false" changes anything, and then only a
    switch that is still on (or has no row yet). After this the flag is not read."""
    from app.settings_registry import REGISTRY

    if _setting_row(db, marker):
        return
    flag = _setting_row(db, flag_key)
    switch = _setting_row(db, switch_key)
    changed = False
    if flag is not None and (flag.value or "").strip().lower() == "false":
        if switch is None:
            db.add(Setting(key=switch_key, value="false", description=REGISTRY[switch_key].description))
            changed = True
        elif (switch.value or "").strip().lower() != "false":
            switch.value = "false"
            changed = True
    if _finish_migration(db, marker, f"One-time merge of {flag_key} into {switch_key}"):
        logger.info("%s page switch migration: %s", what, "turned the page off" if changed else "nothing to change")


def migrate_tickets_page_switch_v1(db: Session) -> None:
    """
    One-time migration: Tickets gets one on/off switch.

    Before v1.11 the Tickets page needed two things on: its sidebar switch
    (sidebar.enabled_tickets) and a separate feature flag (features.show_tickets)
    that also gated the ticket API. The Settings redesign keeps one switch per
    page, so the page stays off after upgrade exactly when either was off.

    Guarded by migration.tickets_page_switch_v1.
    """
    _merge_page_switch(db, "migration.tickets_page_switch_v1", "features.show_tickets",
                       "sidebar.enabled_tickets", "Tickets")


def migrate_ebooks_page_switch_v1(db: Session) -> None:
    """
    One-time migration: eBooks gets one on/off switch.

    Same shape as the Tickets merge: features.show_books folds into
    sidebar.enabled_library. The "Kavita must be configured" rule is not a
    switch and is unaffected.

    Guarded by migration.ebooks_page_switch_v1.
    """
    _merge_page_switch(db, "migration.ebooks_page_switch_v1", "features.show_books",
                       "sidebar.enabled_library", "eBooks")


def migrate_requests_source_v1(db: Session) -> None:
    """
    One-time migration: the two requests pages become one page with a source.

    Before v1.11 there were two nav items: the built-in Requests page and a
    Seerr iframe page ("Requests (Embed)") that only appeared when
    features.show_requests was true and its own switch was on. Now there is one
    Requests page and requests.source says which of the two it shows.

      native  = sidebar.enabled_requests != "false"
      embed   = features.show_requests == "true" and sidebar.enabled_requests_embed != "false"

      native on,  embed off -> source native, Requests on
      native on,  embed on  -> source native, Requests on (native is the current page)
      native off, embed on  -> source seerr_embed, Requests switched on
      native off, embed off -> source native, Requests stays off

    Runs after seeding, so requests.source normally already holds its default
    "native"; only that value (or a missing row) is changed. The Requests row
    keeps the native row's label, icon and sublabel - nothing is copied from
    the embed keys.

    Guarded by migration.requests_source_v1.
    """
    from app.settings_registry import REGISTRY

    marker = "migration.requests_source_v1"
    if _setting_row(db, marker):
        return

    def val(key: str, default: str) -> str:
        row = _setting_row(db, key)
        return (row.value or "").strip().lower() if row is not None else default

    native = val("sidebar.enabled_requests", "true") != "false"
    embed = (val("features.show_requests", "false") == "true"
             and val("sidebar.enabled_requests_embed", "true") != "false")
    target = "seerr_embed" if (not native and embed) else "native"

    source = _setting_row(db, "requests.source")
    if source is None:
        db.add(Setting(key="requests.source", value=target, description=REGISTRY["requests.source"].description))
    elif (source.value or "").strip() == "native" and target == "seerr_embed":
        source.value = "seerr_embed"
    # What the row holds now: an earlier choice other than "native" is kept.
    stored = target if source is None else source.value

    if not native and embed:
        switch = _setting_row(db, "sidebar.enabled_requests")
        if switch is not None:
            switch.value = "true"

    if _finish_migration(db, marker, "One-time merge of the two requests pages into one with a source"):
        logger.info("Requests source migration: source=%s", stored)
