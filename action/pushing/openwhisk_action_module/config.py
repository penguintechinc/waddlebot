"""
Configuration module for OpenWhisk Action Module.
Loads all configuration from environment variables.
"""
import os
from typing import Optional


class Config:
    """Configuration class for OpenWhisk Action Module."""

    # OpenWhisk Configuration
    OPENWHISK_API_HOST: str = os.getenv(
        "OPENWHISK_API_HOST",
        "https://openwhisk.example.com"
    )
    OPENWHISK_AUTH_KEY: str = os.getenv("OPENWHISK_AUTH_KEY", "")  # namespace:key format
    OPENWHISK_NAMESPACE: str = os.getenv("OPENWHISK_NAMESPACE", "guest")
    OPENWHISK_INSECURE: bool = os.getenv("OPENWHISK_INSECURE", "false").lower() == "true"

    # Database Configuration
    # PyDAL expects 'postgres://' not 'postgresql://'
    _raw_db_url: str = os.getenv(
        "DATABASE_URL",
        "postgres://waddlebot:password@localhost:5432/waddlebot"
    )
    DATABASE_URL: str = _raw_db_url.replace("postgresql://", "postgres://")

    # Server Configuration
    GRPC_PORT: int = int(os.getenv("GRPC_PORT", "50062"))
    REST_PORT: int = int(os.getenv("REST_PORT", "8082"))
    MODULE_PORT: int = int(os.getenv("MODULE_PORT", "8082"))  # Alias for REST_PORT

    # Security Configuration
    MODULE_SECRET_KEY: str = os.getenv(
        "MODULE_SECRET_KEY",
        "waddlebot_openwhisk_action_secret_change_me_in_production"
    )
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRATION_SECONDS: int = 3600

    # Module Information
    MODULE_NAME: str = "openwhisk_action_module"
    MODULE_VERSION: str = "1.0.0"

    # Performance Settings
    MAX_WORKERS: int = int(os.getenv("MAX_WORKERS", "20"))
    REQUEST_TIMEOUT: int = int(os.getenv("REQUEST_TIMEOUT", "30"))
    MAX_BATCH_SIZE: int = int(os.getenv("MAX_BATCH_SIZE", "100"))

    # OpenWhisk Settings
    DEFAULT_ACTION_TIMEOUT: int = int(os.getenv("DEFAULT_ACTION_TIMEOUT", "60000"))  # 60 seconds
    MAX_ACTION_TIMEOUT: int = int(os.getenv("MAX_ACTION_TIMEOUT", "600000"))  # 10 minutes

    # Logging Configuration
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
    LOG_DIR: str = os.getenv("LOG_DIR", "/var/log/waddlebotlog")
    ENABLE_SYSLOG: bool = os.getenv("ENABLE_SYSLOG", "false").lower() == "true"
    SYSLOG_HOST: str = os.getenv("SYSLOG_HOST", "localhost")
    SYSLOG_PORT: int = int(os.getenv("SYSLOG_PORT", "514"))
    SYSLOG_FACILITY: str = os.getenv("SYSLOG_FACILITY", "LOCAL0")

    # Testing/Development mode - skips strict validation
    TESTING_MODE: bool = os.getenv("TESTING_MODE", "true").lower() == "true"

    @classmethod
    def validate(cls) -> None:
        """Validate required configuration."""
        if cls.TESTING_MODE:
            # Lenient validation for testing
            if not cls.DATABASE_URL:
                raise ValueError("DATABASE_URL is required")
            return

        # Strict validation for production
        if not cls.OPENWHISK_API_HOST:
            raise ValueError("OPENWHISK_API_HOST is required")
        if not cls.OPENWHISK_AUTH_KEY:
            raise ValueError("OPENWHISK_AUTH_KEY is required (format: namespace:key)")
        if not cls.DATABASE_URL:
            raise ValueError("DATABASE_URL is required")
        if not cls.MODULE_SECRET_KEY or cls.MODULE_SECRET_KEY == "waddlebot_openwhisk_action_secret_change_me_in_production":
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
            "openwhisk_namespace": cls.OPENWHISK_NAMESPACE,
            "openwhisk_api_host": cls.OPENWHISK_API_HOST,
        }
