"""
Configuration module for Slack Action Module
Loads configuration from environment variables
"""
import os
from typing import Optional


class Config:
    """Configuration from environment variables"""

    # Slack API Configuration
    SLACK_BOT_TOKEN: str = os.getenv('SLACK_BOT_TOKEN', '')
    SLACK_APP_TOKEN: str = os.getenv('SLACK_APP_TOKEN', '')  # For socket mode if needed

    # Database Configuration
    _raw_db_url = os.getenv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/waddlebot')
    DATABASE_URL: str = _raw_db_url.replace("postgresql://", "postgres://")

    # gRPC Configuration
    GRPC_PORT: int = int(os.getenv('GRPC_PORT', '50052'))
    GRPC_MAX_WORKERS: int = int(os.getenv('GRPC_MAX_WORKERS', '10'))

    # REST API Configuration
    REST_PORT: int = int(os.getenv('REST_PORT', '8071'))

    # JWT Authentication
    MODULE_SECRET_KEY: str = os.getenv('MODULE_SECRET_KEY', '')
    JWT_ALGORITHM: str = 'HS256'
    JWT_EXPIRY_SECONDS: int = 3600

    # Module Information
    MODULE_NAME: str = 'slack_action_module'
    MODULE_VERSION: str = '1.0.0'

    # Performance Settings
    MAX_CONCURRENT_REQUESTS: int = int(os.getenv('MAX_CONCURRENT_REQUESTS', '100'))
    REQUEST_TIMEOUT: int = int(os.getenv('REQUEST_TIMEOUT', '30'))

    # Logging Configuration
    LOG_LEVEL: str = os.getenv('LOG_LEVEL', 'INFO')
    LOG_DIR: str = os.getenv('LOG_DIR', '/var/log/waddlebotlog')
    ENABLE_SYSLOG: bool = os.getenv('ENABLE_SYSLOG', 'false').lower() == 'true'
    SYSLOG_HOST: str = os.getenv('SYSLOG_HOST', 'localhost')
    SYSLOG_PORT: int = int(os.getenv('SYSLOG_PORT', '514'))
    SYSLOG_FACILITY: str = os.getenv('SYSLOG_FACILITY', 'LOCAL0')

    @classmethod
    def validate(cls) -> list[str]:
        """Validate required configuration"""
        errors = []

        if not cls.SLACK_BOT_TOKEN:
            errors.append('SLACK_BOT_TOKEN is required')

        if not cls.MODULE_SECRET_KEY:
            errors.append('MODULE_SECRET_KEY is required')

        if not cls.DATABASE_URL:
            errors.append('DATABASE_URL is required')

        return errors

    @classmethod
    def get_info(cls) -> dict:
        """Get module information"""
        return {
            'module_name': cls.MODULE_NAME,
            'module_version': cls.MODULE_VERSION,
            'grpc_port': cls.GRPC_PORT,
            'rest_port': cls.REST_PORT,
            'has_slack_token': bool(cls.SLACK_BOT_TOKEN),
            'database_configured': bool(cls.DATABASE_URL)
        }
