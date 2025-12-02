"""
Configuration module for GCP Functions Action Module.
Loads all configuration from environment variables.
"""
import os
from typing import Optional


class Config:
    """Configuration class for GCP Functions Action Module."""

    # GCP Configuration
    GCP_PROJECT_ID: str = os.getenv("GCP_PROJECT_ID", "")
    GCP_REGION: str = os.getenv("GCP_REGION", "us-central1")
    GCP_SERVICE_ACCOUNT_KEY: str = os.getenv("GCP_SERVICE_ACCOUNT_KEY", "")  # JSON string or path
    GCP_SERVICE_ACCOUNT_EMAIL: str = os.getenv("GCP_SERVICE_ACCOUNT_EMAIL", "")

    # GCP API Configuration
    GCP_API_ENDPOINT: str = f"https://cloudfunctions.googleapis.com/v2"
    GCP_API_TIMEOUT: int = int(os.getenv("GCP_API_TIMEOUT", "30"))

    # Database Configuration
    DATABASE_URL: str = os.getenv(
        "DATABASE_URL",
        "postgresql://waddlebot:password@localhost:5432/waddlebot"
    )

    # Server Configuration
    GRPC_PORT: int = int(os.getenv("GRPC_PORT", "50061"))
    REST_PORT: int = int(os.getenv("REST_PORT", "8081"))
    MODULE_PORT: int = int(os.getenv("MODULE_PORT", "8081"))  # Alias for REST_PORT

    # Security Configuration
    MODULE_SECRET_KEY: str = os.getenv(
        "MODULE_SECRET_KEY",
        "waddlebot_gcp_functions_action_secret_change_me_in_production"
    )
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRATION_SECONDS: int = 3600

    # Module Information
    MODULE_NAME: str = "gcp_functions_action_module"
    MODULE_VERSION: str = "1.0.0"

    # Performance Settings
    MAX_WORKERS: int = int(os.getenv("MAX_WORKERS", "20"))
    REQUEST_TIMEOUT: int = int(os.getenv("REQUEST_TIMEOUT", "30"))
    MAX_BATCH_SIZE: int = int(os.getenv("MAX_BATCH_SIZE", "100"))

    # Function Invocation Settings
    FUNCTION_TIMEOUT: int = int(os.getenv("FUNCTION_TIMEOUT", "60"))  # seconds
    MAX_RETRIES: int = int(os.getenv("MAX_RETRIES", "3"))
    RETRY_DELAY: int = int(os.getenv("RETRY_DELAY", "1"))  # seconds

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
        if not cls.GCP_PROJECT_ID:
            raise ValueError("GCP_PROJECT_ID is required")
        if not cls.GCP_SERVICE_ACCOUNT_KEY:
            raise ValueError("GCP_SERVICE_ACCOUNT_KEY is required")
        if not cls.DATABASE_URL:
            raise ValueError("DATABASE_URL is required")
        if not cls.MODULE_SECRET_KEY or cls.MODULE_SECRET_KEY == "waddlebot_gcp_functions_action_secret_change_me_in_production":
            raise ValueError("MODULE_SECRET_KEY must be set to a secure value in production")

    @classmethod
    def to_dict(cls) -> dict:
        """Convert configuration to dictionary (excluding secrets)."""
        return {
            "module_name": cls.MODULE_NAME,
            "module_version": cls.MODULE_VERSION,
            "gcp_project": cls.GCP_PROJECT_ID,
            "gcp_region": cls.GCP_REGION,
            "grpc_port": cls.GRPC_PORT,
            "rest_port": cls.REST_PORT,
            "max_workers": cls.MAX_WORKERS,
            "max_batch_size": cls.MAX_BATCH_SIZE,
            "log_level": cls.LOG_LEVEL,
        }
