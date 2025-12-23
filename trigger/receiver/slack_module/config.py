"""Configuration for slack_module"""
import os

from dotenv import load_dotenv

load_dotenv()


class Config:
    """Slack module configuration from environment variables."""

    MODULE_NAME = 'slack_module'
    MODULE_VERSION = '2.0.0'
    MODULE_PORT = int(os.getenv('MODULE_PORT', '8004'))
    DATABASE_URL = os.getenv(
        'DATABASE_URL',
        'postgresql://waddlebot:password@localhost:5432/waddlebot'
    )
    CORE_API_URL = os.getenv('CORE_API_URL',
                             'http://router-service:8000')
    ROUTER_API_URL = os.getenv(
        'ROUTER_API_URL',
        'http://router-service:8000/api/v1/router'
    )
    LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')
    SECRET_KEY = os.getenv('SECRET_KEY', 'change-me-in-production')

    # Slack Bot Configuration
    SLACK_BOT_TOKEN = os.getenv('SLACK_BOT_TOKEN', '')
    SLACK_SIGNING_SECRET = os.getenv('SLACK_SIGNING_SECRET', '')
    SLACK_APP_TOKEN = os.getenv('SLACK_APP_TOKEN', '')  # For Socket Mode

    # Use Socket Mode instead of HTTP webhooks (for development)
    USE_SOCKET_MODE = os.getenv('USE_SOCKET_MODE', 'false').lower() == 'true'

    @classmethod
    def validate(cls):
        """
        Validate configuration and return errors and warnings separately.

        Returns:
            Tuple of (error_list, warning_list)
        """
        errors = []
        warnings = []

        if not cls.DATABASE_URL:
            errors.append("DATABASE_URL is required")

        # Optional credentials - warn but don't fail startup
        if not cls.SLACK_BOT_TOKEN:
            warnings.append("SLACK_BOT_TOKEN not configured - Slack API calls will fail")

        if not cls.SLACK_SIGNING_SECRET:
            warnings.append("SLACK_SIGNING_SECRET not configured - webhook verification will be skipped")

        return errors, warnings
