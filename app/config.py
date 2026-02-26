"""
Configuration management using pydantic-settings.
All secrets are loaded from environment variables.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Application
    app_name: str = "WebServarr"
    app_version: str = "0.1.0"
    app_env: str = "production"
    app_debug: bool = False
    app_secret_key: str = ""  # Auto-generated on first startup if not set

    # Domain / URL configuration
    app_domain: str = "localhost"
    app_scheme: str = "https"
    cors_origins: str = ""  # Additional CORS origins (comma-separated)
    csp_frame_src: str = ""  # Additional frame-src origins (comma-separated)
    csp_connect_src: str = ""  # Additional connect-src origins (comma-separated)

    @property
    def app_url(self) -> str:
        return f"{self.app_scheme}://{self.app_domain}"

    @property
    def effective_redirect_uri(self) -> str:
        """OIDC redirect URI - uses explicit value or derives from app_url."""
        return self.authentik_redirect_uri or f"{self.app_url}/auth/callback"

    # Database (SQLite)
    database_url: str = "sqlite:////app/data/hms.db"

    # Redis
    redis_url: str = "redis://redis:6379/0"

    # Authentik OIDC
    authentik_url: str = ""
    authentik_client_id: str = ""
    authentik_client_secret: str = ""
    authentik_redirect_uri: str = ""  # Defaults to {app_url}/auth/callback if empty

    # Session configuration
    session_cookie_name: str = "webservarr_session"
    session_max_age: int = 604800  # 7 days in seconds

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore"
    )


# Global settings instance
settings = Settings()
