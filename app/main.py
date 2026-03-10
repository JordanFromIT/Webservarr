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
import logging

from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.config import settings
from app.limiter import limiter
from app.database import init_db, SessionLocal
from app.auth import session_manager
from app.seed import seed_secret_key
from app.routers import news, status, admin, simple_auth, integrations, auth as oidc_auth, plex_auth, branding, notifications, tickets, setup as setup_router
from app.services.notification_poller import start_poller, stop_poller

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
        "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com",
        "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https:",
        "worker-src 'self'",
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


def _serve_page(filepath: str, label: str = "Page"):
    """Read an HTML file and return it, or 404."""
    try:
        with open(filepath, "r") as f:
            return HTMLResponse(content=f.read())
    except FileNotFoundError:
        return JSONResponse(
            status_code=404,
            content={"detail": f"{label} not found. Static files missing."}
        )


# Root endpoint - serve main dashboard
@app.get("/", response_class=HTMLResponse, tags=["Pages"])
async def root(
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the main dashboard page."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/index.html", "Dashboard")


# Login page
@app.get("/login", response_class=HTMLResponse, tags=["Pages"])
async def login_page():
    """Serve the login page."""
    return _serve_page("/app/app/static/login.html", "Login page")


# Requests page (native Overseerr UI)
@app.get("/requests", response_class=HTMLResponse, tags=["Pages"])
async def requests_page(
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the native requests page."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/requests.html", "Requests page")


# Requests embed page (Overseerr iframe wrapper)
@app.get("/requests-embed", response_class=HTMLResponse, tags=["Pages"])
async def requests_embed_page(
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the requests embed page (Overseerr iframe)."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/requests-embed.html", "Requests embed page")


# Legacy redirect: /requests2 → /requests (301)
@app.get("/requests2", response_class=HTMLResponse, tags=["Pages"])
async def requests2_redirect():
    """Redirect old /requests2 URL to /requests."""
    return RedirectResponse(url="/requests", status_code=301)


# Issues page
@app.get("/issues", response_class=HTMLResponse, tags=["Pages"])
async def issues_page(
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the issues page."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/issues.html", "Issues page")


# Calendar page
@app.get("/calendar", response_class=HTMLResponse, tags=["Pages"])
async def calendar_page(
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the combined Radarr/Sonarr calendar page."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/calendar.html", "Calendar page")


# Tickets page
@app.get("/tickets", response_class=HTMLResponse, tags=["Pages"])
async def tickets_page(
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the support tickets page."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/tickets.html", "Tickets page")


# Settings page (admin)
@app.get("/settings", response_class=HTMLResponse, tags=["Pages"])
async def settings_page(
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the settings page."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/settings.html", "Settings page")


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
