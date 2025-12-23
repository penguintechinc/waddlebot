"""
YouTube Action Module Configuration
"""
import os
from typing import Optional


class Config:
    """Configuration management for YouTube Action Module"""

    # Module Info
    MODULE_NAME: str = "youtube_action_module"
    MODULE_VERSION: str = "1.0.0"

    # Server Ports
    GRPC_PORT: int = int(os.getenv("GRPC_PORT", "50054"))
    REST_PORT: int = int(os.getenv("REST_PORT", "8073"))

    # Database
    _raw_db_url = os.getenv(
        "DATABASE_URL",
        "postgresql://user:pass@localhost:5432/waddlebot"
    )
    DATABASE_URL: str = _raw_db_url.replace("postgresql://", "postgres://")

    # YouTube API Configuration
    YOUTUBE_API_KEY: Optional[str] = os.getenv("YOUTUBE_API_KEY")
    YOUTUBE_CLIENT_ID: Optional[str] = os.getenv("YOUTUBE_CLIENT_ID")
    YOUTUBE_CLIENT_SECRET: Optional[str] = os.getenv("YOUTUBE_CLIENT_SECRET")
    YOUTUBE_API_VERSION: str = os.getenv("YOUTUBE_API_VERSION", "v3")

    # OAuth Configuration
    YOUTUBE_REDIRECT_URI: str = os.getenv(
        "YOUTUBE_REDIRECT_URI",
        "http://localhost:8073/oauth/callback"
    )
    YOUTUBE_SCOPES: list[str] = [
        "https://www.googleapis.com/auth/youtube",
        "https://www.googleapis.com/auth/youtube.force-ssl",
    ]

    # Security
    MODULE_SECRET_KEY: str = os.getenv(
        "MODULE_SECRET_KEY",
        "youtube_action_secret_key_change_me_in_production"
    )

    # Performance Settings
    MAX_WORKERS: int = int(os.getenv("MAX_WORKERS", "20"))
    REQUEST_TIMEOUT: int = int(os.getenv("REQUEST_TIMEOUT", "30"))
    MAX_RETRIES: int = int(os.getenv("MAX_RETRIES", "3"))

    # Rate Limiting
    RATE_LIMIT_REQUESTS: int = int(os.getenv("RATE_LIMIT_REQUESTS", "100"))
    RATE_LIMIT_WINDOW: int = int(os.getenv("RATE_LIMIT_WINDOW", "60"))

    # Logging Configuration
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
    LOG_DIR: str = os.getenv("LOG_DIR", "/var/log/waddlebotlog")
    ENABLE_SYSLOG: bool = os.getenv("ENABLE_SYSLOG", "false").lower() == "true"
    SYSLOG_HOST: str = os.getenv("SYSLOG_HOST", "localhost")
    SYSLOG_PORT: int = int(os.getenv("SYSLOG_PORT", "514"))
    SYSLOG_FACILITY: str = os.getenv("SYSLOG_FACILITY", "LOCAL0")

    # Feature Flags
    ENABLE_CHAT_ACTIONS: bool = os.getenv(
        "ENABLE_CHAT_ACTIONS", "true"
    ).lower() == "true"
    ENABLE_VIDEO_ACTIONS: bool = os.getenv(
        "ENABLE_VIDEO_ACTIONS", "true"
    ).lower() == "true"
    ENABLE_PLAYLIST_ACTIONS: bool = os.getenv(
        "ENABLE_PLAYLIST_ACTIONS", "true"
    ).lower() == "true"
    ENABLE_BROADCAST_ACTIONS: bool = os.getenv(
        "ENABLE_BROADCAST_ACTIONS", "true"
    ).lower() == "true"
    ENABLE_COMMENT_ACTIONS: bool = os.getenv(
        "ENABLE_COMMENT_ACTIONS", "true"
    ).lower() == "true"

    @classmethod
    def validate(cls) -> None:
        """Validate configuration"""
        errors = []

        if not cls.YOUTUBE_CLIENT_ID:
            errors.append("YOUTUBE_CLIENT_ID is required")

        if not cls.YOUTUBE_CLIENT_SECRET:
            errors.append("YOUTUBE_CLIENT_SECRET is required")

        if not cls.DATABASE_URL:
            errors.append("DATABASE_URL is required")

        if errors:
            raise ValueError(f"Configuration errors: {', '.join(errors)}")
