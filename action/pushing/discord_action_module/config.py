"""
Configuration management for Discord Action Module

Loads configuration from environment variables
"""

import os
from typing import Optional


class Config:
    """Configuration class for Discord Action Module"""

    # Discord API Configuration
    DISCORD_BOT_TOKEN: str = os.getenv("DISCORD_BOT_TOKEN", "")
    DISCORD_API_VERSION: str = os.getenv("DISCORD_API_VERSION", "10")
    DISCORD_API_BASE: str = f"https://discord.com/api/v{DISCORD_API_VERSION}"

    # Database Configuration
    DATABASE_URL: str = os.getenv(
        "DATABASE_URL",
        "postgresql://user:pass@localhost:5432/waddlebot"
    )

    # Server Configuration
    GRPC_PORT: int = int(os.getenv("GRPC_PORT", "50051"))
    REST_PORT: int = int(os.getenv("REST_PORT", "8070"))
    HOST: str = os.getenv("HOST", "0.0.0.0")

    # Security Configuration
    MODULE_SECRET_KEY: str = os.getenv(
        "MODULE_SECRET_KEY",
        "change_me_in_production_64_char_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    )
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRATION_SECONDS: int = int(os.getenv("JWT_EXPIRATION_SECONDS", "3600"))

    # Module Information
    MODULE_NAME: str = "discord_action_module"
    MODULE_VERSION: str = os.getenv("MODULE_VERSION", "1.0.0")

    # Performance Settings
    MAX_CONCURRENT_REQUESTS: int = int(os.getenv("MAX_CONCURRENT_REQUESTS", "100"))
    REQUEST_TIMEOUT: int = int(os.getenv("REQUEST_TIMEOUT", "30"))

    # Logging Configuration
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
    LOG_DIR: str = os.getenv("LOG_DIR", "/var/log/waddlebotlog")
    ENABLE_SYSLOG: bool = os.getenv("ENABLE_SYSLOG", "false").lower() == "true"
    SYSLOG_HOST: str = os.getenv("SYSLOG_HOST", "localhost")
    SYSLOG_PORT: int = int(os.getenv("SYSLOG_PORT", "514"))
    SYSLOG_FACILITY: str = os.getenv("SYSLOG_FACILITY", "LOCAL0")

    # Discord Rate Limiting
    DISCORD_RATE_LIMIT_GLOBAL: int = int(os.getenv("DISCORD_RATE_LIMIT_GLOBAL", "50"))
    DISCORD_RATE_LIMIT_PER_CHANNEL: int = int(
        os.getenv("DISCORD_RATE_LIMIT_PER_CHANNEL", "5")
    )

    # Retry Configuration
    MAX_RETRIES: int = int(os.getenv("MAX_RETRIES", "3"))
    RETRY_DELAY: float = float(os.getenv("RETRY_DELAY", "1.0"))

    @classmethod
    def validate(cls) -> list[str]:
        """
        Validate configuration and return list of errors

        Returns:
            List of error messages, empty if valid
        """
        errors = []

        if not cls.DISCORD_BOT_TOKEN:
            errors.append("DISCORD_BOT_TOKEN is required")

        if not cls.DATABASE_URL:
            errors.append("DATABASE_URL is required")

        if len(cls.MODULE_SECRET_KEY) < 64:
            errors.append("MODULE_SECRET_KEY must be at least 64 characters")

        if cls.GRPC_PORT < 1 or cls.GRPC_PORT > 65535:
            errors.append("GRPC_PORT must be between 1 and 65535")

        if cls.REST_PORT < 1 or cls.REST_PORT > 65535:
            errors.append("REST_PORT must be between 1 and 65535")

        return errors

    @classmethod
    def get_summary(cls) -> dict:
        """
        Get configuration summary (without sensitive data)

        Returns:
            Dictionary with configuration summary
        """
        return {
            "module_name": cls.MODULE_NAME,
            "module_version": cls.MODULE_VERSION,
            "grpc_port": cls.GRPC_PORT,
            "rest_port": cls.REST_PORT,
            "database_configured": bool(cls.DATABASE_URL),
            "discord_token_configured": bool(cls.DISCORD_BOT_TOKEN),
            "max_concurrent_requests": cls.MAX_CONCURRENT_REQUESTS,
            "request_timeout": cls.REQUEST_TIMEOUT,
            "log_level": cls.LOG_LEVEL,
        }
