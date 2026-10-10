"""
WebServarr - Main FastAPI Application
"""

from fastapi import FastAPI, Request, Cookie, Depends
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from typing import Optional
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import asyncio
import json
import logging
import os

from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from sqlalchemy.orm import Session

from app.config import settings
from app.limiter import limiter
from app.database import get_db, init_db, SessionLocal
from app.auth import session_manager
from app.seed import seed_secret_key
from app.pages import render_page, web_manifest as build_manifest
from app.integrations import plex_player
from app import home_event_log, home_news, web_analytics
from app.routers import news, status, admin, admin_settings, admin_integrations, simple_auth, integrations, auth as oidc_auth, plex_auth, branding, notifications, tickets, setup as setup_router, kavita_proxy, wiki, request_status, player, activity_webhooks, chaptarr_webhook, books, book_personal, book_discovery, access_requests
from app.services.notification_poller import start_poller, stop_poller
from app.services import request_status as request_status_service
from app.services import book_requests as book_requests_service
from app.services import status_feed as status_feed_service
from app.services.shelf_warmer import start_warmer, stop_warmer
from app.services.request_status_warmer import (
    start_warmer as start_request_status_warmer,
    stop_warmer as stop_request_status_warmer,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO if not settings.app_debug else logging.DEBUG,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# httpx/httpcore log every request at INFO as "HTTP Request: GET <full URL>".
# Several integration clients still carry secrets in the query string (Plex
# token, Kavita apiKey, NYT api-key), so at INFO those secrets land in the
# container logs. Raise these loggers to WARNING so request URLs stop being
# logged, without silencing the app's own INFO logging (M7).
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
# Kometa's webhook carries its secret in the address; the access log shows
# it as ".../kometa/…" (app/routers/activity_webhooks.py).
logging.getLogger("uvicorn.access").addFilter(activity_webhooks.HideWebhookTokens())


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan events."""
    # Startup
    logger.info("Starting WebServarr...")
    logger.info(f"Environment: {settings.app_env}")

    # Initialize database
    logger.info("Initializing database...")
    init_db()

    # Move any legacy ticket images out of the public /static tree into the
    # auth-only data dir (idempotent).
    from app.routers.tickets import migrate_ticket_uploads
    migrate_ticket_uploads()

    # On a fresh install, print the one-time setup token. The operator must enter
    # it in the setup wizard, so an anonymous attacker cannot race to claim admin.
    from app.routers.setup import is_setup_completed, get_or_create_setup_token
    if not is_setup_completed():
        _setup_token = get_or_create_setup_token()
        logger.warning("=" * 64)
        logger.warning("FIRST-RUN SETUP TOKEN: %s", _setup_token)
        logger.warning("Enter this token in the setup wizard to create the admin account.")
        logger.warning("=" * 64)

    # Load or generate secret key from database
    db = SessionLocal()
    try:
        secret_key = seed_secret_key(db)
        if not settings.app_secret_key:
            settings.app_secret_key = secret_key
    finally:
        db.close()

    # Initialize Redis connection
    await session_manager.get_redis()
    logger.info("Redis connection established")

    # Start background notification poller
    poller_task = asyncio.create_task(start_poller())
    logger.info("Notification poller launched (polls only while this worker holds the lease)")

    # Trending book shelves are ~46 external round trips to build, against one
    # for a Seerr row, so they are prepared in the background rather than while
    # somebody waits.
    warmer_task = asyncio.create_task(start_warmer())
    logger.info("Trending shelf warmer launched")

    # Working out why every outstanding request is stuck costs five integration
    # calls plus a Plex lookup per title, so it is built on a timer and served
    # from cache rather than computed while somebody waits.
    request_status_task = asyncio.create_task(start_request_status_warmer())
    logger.info("Request status warmer launched")

    logger.info("WebServarr started successfully!")

    yield

    # Shutdown
    logger.info("Shutting down WebServarr...")
    await stop_poller()
    poller_task.cancel()
    try:
        await poller_task
    except asyncio.CancelledError:
        pass
    logger.info("Notification poller stopped")

    await stop_warmer()
    warmer_task.cancel()
    try:
        await warmer_task
    except asyncio.CancelledError:
        pass
    logger.info("Trending shelf warmer stopped")

    await stop_request_status_warmer()
    request_status_task.cancel()
    try:
        await request_status_task
    except asyncio.CancelledError:
        pass
    logger.info("Request status warmer stopped")

    await session_manager.close()
    logger.info("WebServarr shut down")


# Create FastAPI app
app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    debug=settings.app_debug,
    lifespan=lifespan
)

# Rate limiting via slowapi (backed by Redis)
app.state.limiter = limiter


async def _rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    return JSONResponse(
        status_code=429,
        content={"detail": f"Rate limit exceeded: {exc.detail}"},
    )

app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)

# Reject oversized request bodies before anything materialises them
# (memory/disk-exhaustion DoS). Uploads are capped at 2 MB in their handlers;
# 16 MB leaves headroom for multipart envelopes.
MAX_REQUEST_BYTES = 16 * 1024 * 1024


class _BodyTooLarge(Exception):
    """Raised from the wrapped receive() once a streaming body exceeds the cap."""


class BodySizeLimitMiddleware:
    """Pure-ASGI guard that bounds the request body by actually counting bytes.

    A declared Content-Length over the cap is rejected up front, but a
    Transfer-Encoding: chunked body carries no Content-Length — and FastAPI
    buffers the whole body (JSON in memory, multipart spooled to a temp file)
    before auth or rate limiting runs. So the bytes are also counted as they
    stream through receive(), and the request is refused with 413 the moment the
    cap is exceeded, before the body is fully materialised (M9).

    Registered as the innermost middleware, so a 413 it produces still travels
    back out through the rate-limit, CORS and security-header layers, and so the
    over-limit exception has no BaseHTTPMiddleware to cross on its way here.
    """

    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Fast path: refuse a declared oversized Content-Length without reading
        # a single body byte.
        for name, value in scope.get("headers") or []:
            if name == b"content-length":
                try:
                    if int(value) > self.max_bytes:
                        await self._respond(send, 413, "Request body too large")
                        return
                except ValueError:
                    await self._respond(send, 400, "Invalid Content-Length")
                    return
                break

        total = 0

        async def limited_receive():
            nonlocal total
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b"") or b"")
                if total > self.max_bytes:
                    raise _BodyTooLarge()
            return message

        response_started = False

        async def send_wrapper(message):
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, send_wrapper)
        except _BodyTooLarge:
            if response_started:
                # The app began responding before over-reading the body; too
                # late to send a clean 413. Swallow so the worker survives.
                logger.warning(
                    "Request body exceeded %d bytes after the response had started",
                    self.max_bytes,
                )
                return
            await self._respond(send, 413, "Request body too large")

    @staticmethod
    async def _respond(send, status: int, detail: str) -> None:
        body = json.dumps({"detail": detail}).encode()
        await send({
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        })
        await send({"type": "http.response.body", "body": body})


# Innermost middleware (registered first): see the class docstring.
app.add_middleware(BodySizeLimitMiddleware, max_bytes=MAX_REQUEST_BYTES)
app.add_middleware(SlowAPIMiddleware)

# CORS middleware - built from config
_cors_origins = [settings.app_url]
if settings.authentik_url:
    _cors_origins.append(settings.authentik_url)
for origin in settings.cors_origins.split(","):
    origin = origin.strip()
    if origin:
        _cors_origins.append(origin)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)

# Security headers middleware
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    """Add security headers to all responses."""
    response = await call_next(request)

    # The push service worker lives under /static/ but must control the whole
    # origin; without this header the browser rejects the registration.
    if request.url.path == "/static/sw.js":
        response.headers["Service-Worker-Allowed"] = "/"

    # Security headers
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    # HSTS — browsers ignore this over plain HTTP, so it is safe to always send.
    # No includeSubDomains/preload to avoid affecting unrelated subdomains.
    response.headers["Strict-Transport-Security"] = "max-age=31536000"

    # CSP (Content Security Policy) - built from config
    frame_sources = []
    for src in settings.csp_frame_src.split(","):
        src = src.strip()
        if src:
            frame_sources.append(src)

    connect_sources = ["'self'"]
    if settings.authentik_url:
        connect_sources.append(settings.authentik_url)
    for src in settings.csp_connect_src.split(","):
        src = src.strip()
        if src:
            connect_sources.append(src)

    script_sources = ["'self'"]
    # Cloudflare injects its Web Analytics beacon into HTML pages only, so
    # only they ask whether the operator allows it (app/web_analytics.py).
    if ("content-security-policy" not in response.headers
            and response.headers.get("content-type", "").startswith("text/html")
            and await web_analytics.allowed()):
        script_sources.append(web_analytics.SCRIPT_SOURCE)

    csp_directives = [
        "default-src 'self'",
        # No inline script, inline handler or javascript: URL anywhere
        # (test_soft_nav WholeSite), so nothing needs 'unsafe-inline'.
        f"script-src {' '.join(script_sources)}",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https:",
        "worker-src 'self'",
        # The audiobook player streams straight from the listener's Plex
        # server over its plex.direct https addresses, on any port: a
        # server's remote port is whatever its operator mapped (spec 5.4).
        "media-src 'self' https://*.plex.direct:*",
        # Standards-compliant clickjacking defense (supersedes X-Frame-Options).
        "frame-ancestors 'self'",
        "base-uri 'self'",
        "object-src 'none'",
    ]
    if frame_sources:
        csp_directives.append(f"frame-src {' '.join(frame_sources)}")
    csp_directives.append(f"connect-src {' '.join(connect_sources)}")
    # Do not clobber a CSP a route set for itself. Some responses (sanitised
    # Kavita book content, the image proxies) ship a stricter `sandbox` policy;
    # only apply the site-wide default when the route did not set its own.
    if "content-security-policy" not in response.headers:
        response.headers["Content-Security-Policy"] = "; ".join(csp_directives)

    return response


@app.middleware("http")
async def static_cache_headers(request: Request, call_next):
    """Cache policy for /static/.

    Versioned assets carry a ?v= marker that app/pages.py rewrites to the
    file's content hash, so their URL changes whenever they do: cache them
    for a year. Without this every navigation re-validated each script and
    stylesheet (a round trip apiece, and the stylesheets block rendering).
    """
    response = await call_next(request)
    path = request.url.path
    if request.method == "GET" and path.startswith("/static/") and response.status_code in (200, 304):
        if path == "/static/sw.js":
            response.headers["Cache-Control"] = "no-cache"
        elif "v" in request.query_params:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif path.startswith("/static/uploads/"):
            # Uploads are stored under content-hashed names.
            response.headers["Cache-Control"] = "public, max-age=86400"
        else:
            response.headers["Cache-Control"] = "public, max-age=300"
    return response


@app.middleware("http")
async def setup_redirect_middleware(request: Request, call_next):
    """Redirect all traffic to /setup if initial setup not completed."""
    path = request.url.path
    setup_exempt = (
        "/setup",
        "/api/setup/",
        "/static/",
        "/api/branding",
        "/manifest.webmanifest",
        "/health",
    )
    if not any(path.startswith(p) for p in setup_exempt):
        from app.routers.setup import is_setup_completed
        if not is_setup_completed():
            return RedirectResponse(url="/setup", status_code=302)
    return await call_next(request)


# Include routers
app.include_router(setup_router.router, tags=["Setup"])
app.include_router(simple_auth.router, prefix="/auth", tags=["Authentication"])
app.include_router(oidc_auth.router, prefix="/auth", tags=["OIDC Authentication"])
app.include_router(plex_auth.router, prefix="/auth", tags=["Plex Authentication"])
app.include_router(access_requests.router, prefix="/api/access-requests", tags=["Access requests"])
app.include_router(news.router, prefix="/api/news", tags=["News"])
app.include_router(status.router, prefix="/api/status", tags=["Status"])
# The three admin routers share /api/admin. Their paths do not overlap, so
# order is not load-bearing; keep it that way (no catch-all like /settings/{key}).
app.include_router(admin_settings.router, prefix="/api/admin", tags=["Admin settings"])
app.include_router(admin_integrations.router, prefix="/api/admin", tags=["Admin integrations"])
app.include_router(admin.router, prefix="/api/admin", tags=["Admin"])
app.include_router(access_requests.admin_router, prefix="/api/admin", tags=["Admin access requests"])
app.include_router(integrations.router, prefix="/api/integrations", tags=["Integrations"])
app.include_router(branding.router, prefix="/api", tags=["Branding"])
app.include_router(notifications.router, prefix="/api", tags=["Notifications"])
app.include_router(tickets.router, prefix="/api", tags=["Tickets"])
app.include_router(wiki.router, prefix="/api/wiki", tags=["Wiki"])
app.include_router(request_status.router, prefix="/api/request-status", tags=["Request Status"])
app.include_router(player.router, prefix="/api/player", tags=["Player"])
# Before the arr webhooks: their /{app} would take "n8n" as an app.
app.include_router(activity_webhooks.router, prefix="/api/webhooks", tags=["Webhooks"])
app.include_router(chaptarr_webhook.router, prefix="/api/webhooks", tags=["Webhooks"])
app.include_router(book_personal.router, prefix="/api/books", tags=["Books"])
# Before books.router: its /{book_id} route would take /recent and /popular.
app.include_router(book_discovery.router, prefix="/api/books", tags=["Books"])
app.include_router(books.router, prefix="/api/books", tags=["Books"])
app.include_router(books.admin_router, prefix="/api/admin/books", tags=["Admin books"])
# No /api prefix: this router owns /kavita/* and /signin-oidc at the app root.
# /signin-oidc must be at root because Kavita sets its OIDC correlation cookies
# with path=/signin-oidc, and the browser only sends them to that exact path.
app.include_router(kavita_proxy.router, tags=["Kavita"])


# Health check endpoint
@app.get("/health", tags=["Health"])
async def health_check():
    """Health check endpoint for Docker healthcheck."""
    return {"status": "healthy", "version": settings.app_version}


# The web app manifest (app/pages.py web_manifest): what a phone reads to add
# the site to its home screen. Public, like /api/branding (a browser fetches
# it without the session cookie), and revalidated on every use, so a branding
# change reaches the next install.
@app.get("/manifest.webmanifest", include_in_schema=False)
@limiter.limit("60/minute")
async def manifest(request: Request, db: Session = Depends(get_db)):
    return JSONResponse(content=build_manifest(branding.load_branding(db, False)),
                        media_type="application/manifest+json", headers={"Cache-Control": "no-cache"})


# --- Page auth helper ---
async def _require_session(session_id: Optional[str]) -> Optional[dict]:
    """The session dict behind the cookie, or None. Page routes use it both to
    gate access and to render the shell for that user (see app/pages.py)."""
    if not session_id:
        return None
    return await session_manager.get_session(session_id)


# Root endpoint - serve main dashboard
@app.get("/", response_class=HTMLResponse, tags=["Pages"])
async def root(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the main dashboard page."""
    user = await _require_session(session_id)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    return await shell_page("index", request, user, extra_flags={"home_news": _home_news})


async def shell_page(name: str, request: Request, user: dict, **kwargs):
    """render_page for a page with the shell: with the event log's first
    paint (partials/shell-event-log.html), which every shell page but the
    reader carries at the top of its content. extra_flags as render_page."""
    flags = {"feed_off": _event_log_off(), "event_pinned": await _event_log_pinned()}
    flags.update(kwargs.pop("extra_flags", None) or {})
    return render_page(name, request, user, extra_flags=flags, **kwargs)


def _home_news(branding: dict):
    """Home's news cards for the page render (app/home_news.py), with the time
    they were judged new or old at; None leaves the section to the script."""
    news = home_news.load_home_news(branding)
    if news is not None:
        news["now_ms"] = home_news.now_ms()
    return news


async def _event_log_pinned() -> Optional[dict]:
    """The event log's pinned problems for the page render
    (app/home_event_log.py): the feed's open outages and important notes,
    none when the feed would answer "unavailable" (js/event-log.js shows none
    then either). None leaves them to the script."""
    db = None
    try:
        db = SessionLocal()
        items = status_feed_service.pinned_items(db)
        configured = status_feed_service.kuma_configured(db)
    except Exception:  # noqa: BLE001 - the page script writes them instead
        logger.warning("Could not read the event log's pinned problems", exc_info=True)
        return None
    finally:
        if db is not None:
            db.close()
    if items and configured and not await status_feed_service.kuma_answering():
        items = []
    return {"items": items, "now_ms": home_event_log.now_ms()}


def _event_log_off() -> bool:
    """The event log starts hidden when the status feed is off and empty
    (status_feed.home_off). Not knowing (no database) leaves it to the script."""
    db = None
    try:
        db = SessionLocal()
        return status_feed_service.home_off(db, status_feed_service.now_utc())
    except Exception:  # noqa: BLE001 - a hint only; the page script decides again
        logger.warning("Could not read whether the event log is off", exc_info=True)
        return False
    finally:
        if db is not None:
            db.close()


# Login page
@app.get("/login", response_class=HTMLResponse, tags=["Pages"])
async def login_page(request: Request):
    """Serve the login page."""
    return render_page("login", request, None)


def _requests_page(branding: dict) -> str:
    """The Requests page shows the built-in UI or the Seerr embed (Settings > Pages)."""
    return "requests-embed" if branding.get("requests_source") == "seerr_embed" else "requests"


# Requests page (native Seerr UI, or the Seerr iframe when that is the source)
@app.get("/requests", response_class=HTMLResponse, tags=["Pages"])
async def requests_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the requests page from the operator's chosen source."""
    user = await _require_session(session_id)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    # Request Status starts collapsed when the cached snapshot (the one its API
    # will return) has nothing waiting, so hiding it never moves the page. A
    # cold cache (None) leaves the section to the page script. Book requests
    # share the section, so it collapses only when their cached snapshot has
    # nothing waiting either (a cold book cache again leaves it to the page).
    snapshot = await request_status_service.get_cached_snapshot()
    rs_empty = isinstance(snapshot, dict) and (bool(snapshot.get("error")) or not snapshot.get("items"))
    if rs_empty:
        books = await book_requests_service.get_cached_snapshot()
        rs_empty = isinstance(books, dict) and not books.get("items")
    return await shell_page("requests", request, user, gate="requests", pick=_requests_page,
                            extra_flags={"rs_empty": rs_empty})


# Legacy redirect: /requests-embed → /requests (301)
@app.get("/requests-embed", include_in_schema=False)
async def requests_embed_redirect(request: Request):
    """The Seerr embed is now what /requests shows when it is the chosen source."""
    query = request.url.query
    return RedirectResponse(url="/requests" + ("?" + query if query else ""), status_code=301)


# Legacy redirect: /requests2 → /requests (301)
@app.get("/requests2", response_class=HTMLResponse, tags=["Pages"])
async def requests2_redirect():
    """Redirect old /requests2 URL to /requests."""
    return RedirectResponse(url="/requests", status_code=301)


# Issues page
@app.get("/issues", response_class=HTMLResponse, tags=["Pages"])
async def issues_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the issues page."""
    user = await _require_session(session_id)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    return await shell_page("issues", request, user, gate="issues")


# News archive page
@app.get("/news", response_class=HTMLResponse, tags=["Pages"])
async def news_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the full news archive. The homepage only carries recent posts."""
    user = await _require_session(session_id)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    return await shell_page("news", request, user)


# Wiki
@app.get("/wiki", response_class=HTMLResponse, tags=["Pages"])
async def wiki_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the wiki index."""
    user = await _require_session(session_id)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    return await shell_page("wiki", request, user, gate="wiki")


@app.get("/wiki/{slug}", response_class=HTMLResponse, tags=["Pages"])
async def wiki_article_page(
    slug: str,
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve one wiki page.

    Same file as the index: the client reads location.pathname and renders the
    matching view, so a pasted deep link cold-loads onto that page instead of
    flashing the index first.
    """
    user = await _require_session(session_id)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    return await shell_page("wiki", request, user, gate="wiki")


# Calendar page
@app.get("/calendar", response_class=HTMLResponse, tags=["Pages"])
async def calendar_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the combined Radarr/Sonarr calendar page."""
    user = await _require_session(session_id)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    return await shell_page("calendar", request, user, gate="calendar")


@app.get("/tickets", response_class=HTMLResponse, tags=["Pages"])
async def tickets_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the support tickets page."""
    user = await _require_session(session_id)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    return await shell_page("tickets", request, user, gate="tickets")


# Books page (ebooks from Kavita and audiobooks from Plex, in one library)
@app.get("/books", response_class=HTMLResponse, tags=["Pages"])
async def books_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the Books page: search, Continue and the library grid."""
    user = await _require_session(session_id)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    return await shell_page("books", request, user, gate="library")


# A person's or a series' books (names travel in the query string, so a "/" or a
# comma in one is safe). These are declared before the book route; its id is a
# whole number, so neither can be taken for a book.
@app.get("/books/person", response_class=HTMLResponse, tags=["Pages"])
async def books_person_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve an author's or narrator's page: ?role=author|narrator&name=..."""
    user = await _require_session(session_id)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    return await shell_page("books-person", request, user, gate="library")


@app.get("/books/series", response_class=HTMLResponse, tags=["Pages"])
async def books_series_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve a series page: ?name=..., its books in reading order."""
    user = await _require_session(session_id)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    return await shell_page("books-series", request, user, gate="library")


@app.get("/books/stats", response_class=HTMLResponse, tags=["Pages"])
async def books_stats_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve Your stats: the person's own listening and reading (the page asks
    /api/books/me/stats, which answers for the session's account only)."""
    user = await _require_session(session_id)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    return await shell_page("books-stats", request, user, gate="library")


@app.get("/books/{book_id:int}", response_class=HTMLResponse, tags=["Pages"])
async def book_page(
    request: Request,
    book_id: int,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve one book: the Books page with the book's pop-up open (a refresh or
    a shared link of the address a click on a book gives). Whether the book
    exists, and what this person may see of it, is the pop-up's own question
    to /api/books/<id>."""
    user = await _require_session(session_id)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    return await shell_page("books", request, user, gate="library", extra_flags={"book_open": True})


# Legacy redirects: /ebooks (the old eBooks page) and /library (before that) → /books (301)
@app.get("/ebooks", include_in_schema=False)
@app.get("/library", include_in_schema=False)
async def ebooks_redirect(request: Request):
    """The eBooks page became Books; old links and bookmarks keep working."""
    query = request.url.query
    return RedirectResponse(url="/books" + ("?" + query if query else ""), status_code=301)


# Ebook reader page
@app.get("/reader", response_class=HTMLResponse, tags=["Pages"])
async def reader_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the ebook reader."""
    user = await _require_session(session_id)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    return render_page("reader", request, user, gate="library")


# Settings page (admin)
@app.get("/settings", response_class=HTMLResponse, tags=["Pages"])
async def settings_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the settings page."""
    user = await _require_session(session_id)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    if user.get("is_admin") != "true":
        return RedirectResponse(url="/", status_code=302)
    return await shell_page("settings", request, user)


# The audiobook player's test launcher (admin only, not in the navigation)
@app.get("/player-test", response_class=HTMLResponse, include_in_schema=False)
async def player_test_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Every audiobook with a Play button, for admins testing the player.

    Anyone else, signed in or not, and everyone while the player is off, gets
    the 404 an unknown address gets: the page is not there for them. Rate
    limited by the app limiter's default, as every page is."""
    user = await _require_session(session_id)
    if not user or user.get("is_admin") != "true" or not plex_player.player_on():
        return JSONResponse(status_code=404, content={"detail": "Not Found"})
    return await shell_page("player-test", request, user)


# The player's remote window (desktop Pop out where the browser has no
# Picture-in-Picture for pages): a small window that controls the player in
# the tab that opened it, and can carry on playing from the saved place.
@app.get("/player/remote", response_class=HTMLResponse, include_in_schema=False)
async def player_remote_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the player's remote window. It plays nothing until the listener
    asks it to, and then it is the shell's own player, under Books' gate."""
    user = await _require_session(session_id)
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    return render_page("player-remote", request, user, gate="library")


@app.get("/settings/next", include_in_schema=False)
async def settings_next_redirect():
    """The redesign was previewed here during v1.11 development."""
    return RedirectResponse(url="/settings", status_code=301)


class _StaticFiles(StaticFiles):
    """StaticFiles that never serves a page's own file (any .html at the top
    of the static directory; the shell's partials sit in partials/).

    Each page is rendered by its route, which applies its gate (sign-in, the
    page switch, admin only) and fills in its data. Served raw from /static,
    the player's test launcher would let the router mount its module for
    anyone, and every other page would skip its gate. `path` here is already
    normalised (StaticFiles.get_path), but a leading ".." survives that
    ("../static/settings.html" leaves the directory and comes back), so any
    path with a ".." component is refused, and the decision is made on the
    file the path really resolves to. Every spelling that would reach a page
    ("//", "./", "js/../", "%2e%2e/static/", an encoded character) gets the
    404 a missing file gets."""

    async def get_response(self, path: str, scope):
        if ".." in path.split(os.sep) or self._is_page_file(path):
            raise StarletteHTTPException(status_code=404)
        return await super().get_response(path, scope)

    def _is_page_file(self, path: str) -> bool:
        """True for an .html file directly in the static directory, read from
        the real path (symlinks resolved) the request would be served from."""
        root = os.path.realpath(self.directory)
        try:
            real = os.path.realpath(os.path.join(root, path))
        except ValueError:         # a NUL byte: StaticFiles answers 404 for it too
            return False
        return os.path.dirname(real) == root and real.lower().endswith(".html")


# Mount static files (CSS, JS, images, etc.)
# This should be last to avoid catching API routes
app.mount("/static", _StaticFiles(directory="/app/app/static"), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=7979,
        reload=settings.app_debug,
        workers=1 if settings.app_debug else 2
    )
