"""
Configuration module for Twitch Action Module.
Loads all configuration from environment variables.
"""
import os
from typing import Optional


class Config:
    """Configuration class for Twitch Action Module."""

    # Twitch API Configuration
    TWITCH_CLIENT_ID: str = os.getenv("TWITCH_CLIENT_ID", "")
    TWITCH_CLIENT_SECRET: str = os.getenv("TWITCH_CLIENT_SECRET", "")
    TWITCH_API_BASE_URL: str = "https://api.twitch.tv/helix"

    # Database Configuration
    _raw_db_url = os.getenv(
        "DATABASE_URL",
        "postgresql://waddlebot:password@localhost:5432/waddlebot"
    )
    DATABASE_URL: str = _raw_db_url.replace("postgresql://", "postgres://")

    # Server Configuration
    GRPC_PORT: int = int(os.getenv("GRPC_PORT", "50053"))
    REST_PORT: int = int(os.getenv("REST_PORT", "8072"))
    MODULE_PORT: int = int(os.getenv("MODULE_PORT", "8072"))  # Alias for REST_PORT

    # Security Configuration
    MODULE_SECRET_KEY: str = os.getenv(
        "MODULE_SECRET_KEY",
        "waddlebot_twitch_action_secret_change_me_in_production"
    )
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRATION_SECONDS: int = 3600

    # Module Information
    MODULE_NAME: str = "twitch_action_module"
    MODULE_VERSION: str = "1.0.0"

    # Performance Settings
    MAX_WORKERS: int = int(os.getenv("MAX_WORKERS", "20"))
    REQUEST_TIMEOUT: int = int(os.getenv("REQUEST_TIMEOUT", "30"))
    MAX_BATCH_SIZE: int = int(os.getenv("MAX_BATCH_SIZE", "100"))

    # Token Management
    TOKEN_REFRESH_BUFFER: int = int(os.getenv("TOKEN_REFRESH_BUFFER", "300"))  # 5 minutes

    # Logging Configuration
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
    LOG_DIR: str = os.getenv("LOG_DIR", "/var/log/waddlebotlog")
    ENABLE_SYSLOG: bool = os.getenv("ENABLE_SYSLOG", "false").lower() == "true"
    SYSLOG_HOST: str = os.getenv("SYSLOG_HOST", "localhost")
    SYSLOG_PORT: int = int(os.getenv("SYSLOG_PORT", "514"))
    SYSLOG_FACILITY: str = os.getenv("SYSLOG_FACILITY", "LOCAL0")

    @classmethod
    def validate(cls) -> None:
        """Validate required configuration."""
        if not cls.TWITCH_CLIENT_ID:
            raise ValueError("TWITCH_CLIENT_ID is required")
        if not cls.TWITCH_CLIENT_SECRET:
            raise ValueError("TWITCH_CLIENT_SECRET is required")
        if not cls.DATABASE_URL:
            raise ValueError("DATABASE_URL is required")
        if not cls.MODULE_SECRET_KEY or cls.MODULE_SECRET_KEY == "waddlebot_twitch_action_secret_change_me_in_production":
            raise ValueError("MODULE_SECRET_KEY must be set to a secure value in production")

    @classmethod
    def to_dict(cls) -> dict:
        """Convert configuration to dictionary (excluding secrets)."""
        return {
            "module_name": cls.MODULE_NAME,
            "module_version": cls.MODULE_VERSION,
            "grpc_port": cls.GRPC_PORT,
            "rest_port": cls.REST_PORT,
            "max_workers": cls.MAX_WORKERS,
            "max_batch_size": cls.MAX_BATCH_SIZE,
            "log_level": cls.LOG_LEVEL,
        }
