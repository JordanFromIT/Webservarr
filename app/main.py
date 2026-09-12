"""
WebServarr - Main FastAPI Application
"""

from fastapi import FastAPI, Request, Cookie
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from typing import Optional
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import asyncio
import html
import logging
import re
from pathlib import Path

from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.config import settings
from app.limiter import limiter
from app.database import init_db, SessionLocal
from app.auth import session_manager
from app.seed import seed_secret_key
from app.routers import news, status, admin, simple_auth, integrations, auth as oidc_auth, plex_auth, branding, notifications, tickets, setup as setup_router, kavita_proxy, wiki, request_status
from app.services.notification_poller import start_poller, stop_poller
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
    logger.info("Notification poller launched")

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
app.add_middleware(SlowAPIMiddleware)


async def _rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    return JSONResponse(
        status_code=429,
        content={"detail": f"Rate limit exceeded: {exc.detail}"},
    )

app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)

# Reject oversized request bodies early (memory-exhaustion DoS). Uploads are
# capped at 2 MB in their handlers; 16 MB leaves headroom for multipart envelopes.
MAX_REQUEST_BYTES = 16 * 1024 * 1024


@app.middleware("http")
async def limit_request_body(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_REQUEST_BYTES:
                return JSONResponse(status_code=413, content={"detail": "Request body too large"})
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})
    return await call_next(request)

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

    csp_directives = [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https:",
        "worker-src 'self'",
        # Standards-compliant clickjacking defense (supersedes X-Frame-Options).
        "frame-ancestors 'self'",
        "base-uri 'self'",
        "object-src 'none'",
    ]
    if frame_sources:
        csp_directives.append(f"frame-src {' '.join(frame_sources)}")
    csp_directives.append(f"connect-src {' '.join(connect_sources)}")
    response.headers["Content-Security-Policy"] = "; ".join(csp_directives)

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
        "/api/admin/test-connection",
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
app.include_router(news.router, prefix="/api/news", tags=["News"])
app.include_router(status.router, prefix="/api/status", tags=["Status"])
app.include_router(admin.router, prefix="/api/admin", tags=["Admin"])
app.include_router(integrations.router, prefix="/api/integrations", tags=["Integrations"])
app.include_router(branding.router, prefix="/api", tags=["Branding"])
app.include_router(notifications.router, prefix="/api", tags=["Notifications"])
app.include_router(tickets.router, prefix="/api", tags=["Tickets"])
app.include_router(wiki.router, prefix="/api/wiki", tags=["Wiki"])
app.include_router(request_status.router, prefix="/api/request-status", tags=["Request Status"])
# No /api prefix: this router owns /kavita/* and /signin-oidc at the app root.
# /signin-oidc must be at root because Kavita sets its OIDC correlation cookies
# with path=/signin-oidc, and the browser only sends them to that exact path.
app.include_router(kavita_proxy.router, tags=["Kavita"])


# Health check endpoint
@app.get("/health", tags=["Health"])
async def health_check():
    """Health check endpoint for Docker healthcheck."""
    return {"status": "healthy", "version": settings.app_version}


# --- Page auth helper ---
async def _require_session(session_id: Optional[str]) -> bool:
    """Check if the session cookie maps to a valid session."""
    if not session_id:
        return False
    return bool(await session_manager.get_session(session_id))


# Link-preview (Open Graph) support.
#
# Messaging apps, Discord, Slack and search crawlers read the HTML they are
# served and never execute JavaScript, so theme-loader can never reach them --
# whatever is baked into the static file is what the world sees. The pages ship
# with a hardcoded "WebServarr" title, which is why a shared link previews under
# the software's name instead of the operator's. These tags are therefore
# stamped in server-side, from the same branding settings the UI already uses.

_TITLE_RE = re.compile(r"<title>.*?</title>", re.IGNORECASE | re.DOTALL)

# Existing titles read "WebServarr - Control Center". Keep the descriptive half,
# swap the brand half, so every page stays self-describing in a browser tab.
_TITLE_SUFFIX_RE = re.compile(r"^\s*\S.*?\s+-\s+(?P<suffix>.+?)\s*$", re.DOTALL)


def _branding_for_preview() -> dict:
    """
    Read the three branding settings the link preview needs.

    Deliberately its own short-lived session rather than a request dependency:
    every page route needs this, and threading a DB session through the static
    file handlers would buy nothing. Any failure falls back to the packaged
    defaults -- a database hiccup must not stop a page from being served.
    """
    from app.routers.branding import DEFAULTS

    values = {
        "app_name": DEFAULTS["branding.app_name"],
        "tagline": DEFAULTS["branding.tagline"],
        "logo_url": DEFAULTS["branding.logo_url"],
    }
    db = None
    try:
        from app.models import Setting

        db = SessionLocal()
        keys = ["branding.app_name", "branding.tagline", "branding.logo_url"]
        for row in db.query(Setting).filter(Setting.key.in_(keys)).all():
            if row.value:
                values[row.key.split(".", 1)[1]] = row.value
    except Exception:  # pragma: no cover - defensive
        logger.warning("Could not read branding for link preview; using defaults", exc_info=True)
    finally:
        if db is not None:
            db.close()
    return values


def _base_url(request: Optional[Request]) -> str:
    """Absolute scheme://host for this request, honouring the Cloudflare proxy."""
    if request is None:
        return ""
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
    if not proto:
        proto = request.url.scheme or "https"
    host = (
        request.headers.get("x-forwarded-host", "").split(",")[0].strip()
        or request.headers.get("host", "").strip()
        or request.url.netloc
    )
    if not host:
        return ""
    return f"{proto}://{host}"


def _preview_meta(request: Optional[Request]) -> tuple[str, str]:
    """
    Build (page_title, meta_tags_html) for the link preview.

    The image is omitted when the logo is an SVG: no major messaging client
    renders SVG in a link card, and advertising one produces a preview with a
    broken thumbnail rather than the clean text-only card you get without it.
    Uploaded logos are always PNG/JPEG/WebP, so uploading one turns the image on.
    """
    brand = _branding_for_preview()
    app_name = brand["app_name"].strip() or "WebServarr"
    tagline = brand["tagline"].strip()
    base = _base_url(request)

    image_url = ""
    logo = brand["logo_url"].strip()
    if logo and not logo.lower().endswith(".svg"):
        image_url = logo if logo.startswith(("http://", "https://")) else f"{base}{logo}"

    page_url = f"{base}{request.url.path}" if base and request is not None else ""

    e = lambda v: html.escape(v, quote=True)
    tags = [
        f'<meta property="og:site_name" content="{e(app_name)}">',
        f'<meta property="og:title" content="{e(app_name)}">',
        '<meta property="og:type" content="website">',
        f'<meta name="twitter:title" content="{e(app_name)}">',
    ]
    if tagline:
        tags.insert(0, f'<meta name="description" content="{e(tagline)}">')
        tags.append(f'<meta property="og:description" content="{e(tagline)}">')
        tags.append(f'<meta name="twitter:description" content="{e(tagline)}">')
    if page_url:
        tags.append(f'<meta property="og:url" content="{e(page_url)}">')
    if image_url:
        tags.append(f'<meta property="og:image" content="{e(image_url)}">')
        tags.append(f'<meta name="twitter:image" content="{e(image_url)}">')
        tags.append('<meta name="twitter:card" content="summary_large_image">')
    else:
        tags.append('<meta name="twitter:card" content="summary">')

    return app_name, "\n".join(tags)


# Cache-busting for local scripts and stylesheets.
#
# Every page carries hand-written "?v=NN" markers on its own script and link
# tags, which means adding a nav entry to the shared sidebar requires bumping
# that number in all eleven pages by hand. Two separate sessions have now added
# a nav item, missed a page, and shipped a sidebar that browsers never
# re-fetched -- the file on the server was correct and the nav was still stale
# in everyone's browser.
#
# The marker is therefore rewritten at serve time to the running app version.
# The number in the HTML no longer matters, every release invalidates the cache
# exactly once, and nobody has to remember. Only local /static/ assets are
# touched, and only an existing ?v= marker is replaced, so nothing gains a
# query string that did not already have one.
_ASSET_VERSION_RE = re.compile(r'(?P<attr>(?:src|href)="/static/[^"?]+\?v=)[^"]*"')


def _stamp_asset_versions(content: str) -> str:
    version = (settings.app_version or "dev").strip() or "dev"
    return _ASSET_VERSION_RE.sub(lambda m: f'{m.group("attr")}{version}"', content)


def _inject_preview_meta(content: str, request: Optional[Request]) -> str:
    """Rewrite <title> and append the preview meta tags immediately after it."""
    app_name, tags = _preview_meta(request)

    def _rewrite(match: "re.Match") -> str:
        inner = match.group(0)[len("<title>"):-len("</title>")]
        suffix_match = _TITLE_SUFFIX_RE.match(inner)
        title = f"{app_name} - {suffix_match.group('suffix')}" if suffix_match else app_name
        return f"<title>{html.escape(title)}</title>\n{tags}"

    content, count = _TITLE_RE.subn(_rewrite, content, count=1)
    if count == 0:
        # No <title> to anchor to; fall back to the top of <head>.
        content = content.replace("<head>", f"<head>\n<title>{html.escape(app_name)}</title>\n{tags}", 1)
    return content


# Static shell partial (sidebar + header + mobile top bar/drawer).
#
# The shell used to be built client-side by sidebar.js/header.js after page
# load, which meant every page painted an empty nav until JS ran. The marker
# below is swapped for the partial's raw markup at serve time instead, so the
# nav is part of the HTML the browser receives -- it paints before any script
# executes. `Path(__file__).parent`-relative so this works from any checkout,
# not just the container's `/app/app/...` layout.
SHELL_MARKER = "<!--WEBSERVARR:SHELL-->"
_SHELL_PARTIAL_PATH = Path(__file__).parent / "static" / "partials" / "shell.html"
_shell_partial_cache: Optional[str] = None


def _load_shell_partial() -> str:
    global _shell_partial_cache
    if _shell_partial_cache is None:
        _shell_partial_cache = _SHELL_PARTIAL_PATH.read_text(encoding="utf-8")
    return _shell_partial_cache


def _inject_shell(content: str) -> str:
    """Replace the shell marker with the static partial. A no-op for pages
    that carry no marker (login, setup, reader)."""
    if SHELL_MARKER not in content:
        return content
    return content.replace(SHELL_MARKER, _load_shell_partial(), 1)


def _serve_page(filepath: str, label: str = "Page", request: Optional[Request] = None):
    """Read an HTML file, stamp in the link-preview tags, and return it, or 404."""
    try:
        with open(filepath, "r") as f:
            content = f.read()
    except FileNotFoundError:
        return JSONResponse(
            status_code=404,
            content={"detail": f"{label} not found. Static files missing."}
        )
    try:
        content = _inject_preview_meta(content, request)
    except Exception:  # pragma: no cover - a preview must never break a page
        logger.warning("Link-preview injection failed for %s", label, exc_info=True)
    try:
        content = _inject_shell(content)
    except Exception:  # pragma: no cover - a missing partial must never break a page
        logger.warning("Shell injection failed for %s", label, exc_info=True)
    try:
        content = _stamp_asset_versions(content)
    except Exception:  # pragma: no cover - a stale asset beats a broken page
        logger.warning("Asset version stamping failed for %s", label, exc_info=True)
    return HTMLResponse(content=content)


# Root endpoint - serve main dashboard
@app.get("/", response_class=HTMLResponse, tags=["Pages"])
async def root(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the main dashboard page."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/index.html", "Dashboard", request)


# Login page
@app.get("/login", response_class=HTMLResponse, tags=["Pages"])
async def login_page(request: Request):
    """Serve the login page."""
    return _serve_page("/app/app/static/login.html", "Login page", request)


# Requests page (native Seerr UI)
@app.get("/requests", response_class=HTMLResponse, tags=["Pages"])
async def requests_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the native requests page."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/requests.html", "Requests page", request)


# Requests embed page (Seerr iframe wrapper)
@app.get("/requests-embed", response_class=HTMLResponse, tags=["Pages"])
async def requests_embed_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the requests embed page (Seerr iframe)."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/requests-embed.html", "Requests embed page", request)


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
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/issues.html", "Issues page", request)


# News archive page
@app.get("/news", response_class=HTMLResponse, tags=["Pages"])
async def news_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the full news archive. The homepage only carries recent posts."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/news.html", "News page", request)


# Wiki
@app.get("/wiki", response_class=HTMLResponse, tags=["Pages"])
async def wiki_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the wiki index."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/wiki.html", "Wiki page", request)


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
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/wiki.html", "Wiki page", request)


# Calendar page
@app.get("/calendar", response_class=HTMLResponse, tags=["Pages"])
async def calendar_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the combined Radarr/Sonarr calendar page."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/calendar.html", "Calendar page", request)


@app.get("/tickets", response_class=HTMLResponse, tags=["Pages"])
async def tickets_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the support tickets page."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/tickets.html", "Tickets page", request)


# Ebook library page
@app.get("/library", response_class=HTMLResponse, tags=["Pages"])
async def library_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the ebook library browse page."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/library.html", "Library page", request)


# Ebook reader page
@app.get("/reader", response_class=HTMLResponse, tags=["Pages"])
async def reader_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the ebook reader."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/reader.html", "Reader page", request)


# Settings page (admin)
@app.get("/settings", response_class=HTMLResponse, tags=["Pages"])
async def settings_page(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the settings page."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/settings.html", "Settings page", request)


# Mount static files (CSS, JS, images, etc.)
# This should be last to avoid catching API routes
app.mount("/static", StaticFiles(directory="/app/app/static"), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=7979,
        reload=settings.app_debug,
        workers=1 if settings.app_debug else 2
    )
