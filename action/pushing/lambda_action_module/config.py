"""
Configuration management for Lambda Action Module

Loads configuration from environment variables
"""

import os
from typing import Optional


class Config:
    """Configuration class for Lambda Action Module"""

    # AWS Configuration
    AWS_ACCESS_KEY_ID: str = os.getenv("AWS_ACCESS_KEY_ID", "")
    AWS_SECRET_ACCESS_KEY: str = os.getenv("AWS_SECRET_ACCESS_KEY", "")
    AWS_REGION: str = os.getenv("AWS_REGION", "us-east-1")
    AWS_LAMBDA_ROLE_ARN: str = os.getenv("AWS_LAMBDA_ROLE_ARN", "")

    # Database Configuration
    # PyDAL expects 'postgres://' not 'postgresql://'
    _raw_db_url: str = os.getenv(
        "DATABASE_URL",
        "postgres://user:pass@localhost:5432/waddlebot"
    )
    DATABASE_URL: str = _raw_db_url.replace("postgresql://", "postgres://")

    # Server Configuration
    GRPC_PORT: int = int(os.getenv("GRPC_PORT", "50060"))
    REST_PORT: int = int(os.getenv("REST_PORT", "8080"))
    HOST: str = os.getenv("HOST", "0.0.0.0")

    # Security Configuration
    MODULE_SECRET_KEY: str = os.getenv(
        "MODULE_SECRET_KEY",
        "change_me_in_production_64_char_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    )
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRATION_SECONDS: int = int(os.getenv("JWT_EXPIRATION_SECONDS", "3600"))

    # Module Information
    MODULE_NAME: str = "lambda_action_module"
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

    # Lambda Configuration
    LAMBDA_FUNCTION_PREFIX: str = os.getenv("LAMBDA_FUNCTION_PREFIX", "waddlebot-")
    LAMBDA_TIMEOUT: int = int(os.getenv("LAMBDA_TIMEOUT", "300"))
    LAMBDA_MEMORY_SIZE: int = int(os.getenv("LAMBDA_MEMORY_SIZE", "512"))
    LAMBDA_MAX_RETRIES: int = int(os.getenv("LAMBDA_MAX_RETRIES", "3"))

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

        if not cls.AWS_ACCESS_KEY_ID:
            errors.append("AWS_ACCESS_KEY_ID is required")

        if not cls.AWS_SECRET_ACCESS_KEY:
            errors.append("AWS_SECRET_ACCESS_KEY is required")

        if not cls.AWS_REGION:
            errors.append("AWS_REGION is required")

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
            "aws_configured": bool(cls.AWS_ACCESS_KEY_ID and cls.AWS_SECRET_ACCESS_KEY),
            "aws_region": cls.AWS_REGION,
            "max_concurrent_requests": cls.MAX_CONCURRENT_REQUESTS,
            "request_timeout": cls.REQUEST_TIMEOUT,
            "log_level": cls.LOG_LEVEL,
        }
