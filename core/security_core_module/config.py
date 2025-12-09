"""
Security Core Module Configuration
"""
import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    """Security module configuration from environment variables."""

    # Module identity
    MODULE_NAME = 'security-core'
    MODULE_VERSION = '1.0.0'
    MODULE_PORT = int(os.getenv('MODULE_PORT', '8041'))

    # Database
    DATABASE_URL = os.getenv(
        'DATABASE_URL',
        'postgresql://waddlebot:waddlebot123@localhost:5432/waddlebot'
    )

    # Redis for rate limiting and caching
    REDIS_HOST = os.getenv('REDIS_HOST', 'localhost')
    REDIS_PORT = int(os.getenv('REDIS_PORT', '6379'))
    REDIS_PASSWORD = os.getenv('REDIS_PASSWORD', '')
    REDIS_DB = int(os.getenv('REDIS_DB', '1'))  # Use DB 1 for security

    # Internal service URLs
    ROUTER_API_URL = os.getenv(
        'ROUTER_API_URL',
        'http://router:8000/api/v1/router'
    )
    REPUTATION_API_URL = os.getenv(
        'REPUTATION_API_URL',
        'http://reputation:8021/api/v1/reputation'
    )

    # Logging
    LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')
    SECRET_KEY = os.getenv('SECRET_KEY', 'change-me-in-production')
    SERVICE_API_KEY = os.getenv('SERVICE_API_KEY', '')

    # Default spam detection settings
    DEFAULT_SPAM_MESSAGE_THRESHOLD = 5  # messages per interval
    DEFAULT_SPAM_INTERVAL_SECONDS = 10
    DEFAULT_SPAM_DUPLICATE_THRESHOLD = 3

    # Default rate limiting
    DEFAULT_RATE_LIMIT_MESSAGES_PER_MINUTE = 30
    DEFAULT_RATE_LIMIT_COMMANDS_PER_MINUTE = 10

    # Default warning system
    DEFAULT_WARNING_THRESHOLD_TIMEOUT = 3
    DEFAULT_WARNING_THRESHOLD_BAN = 5
    DEFAULT_WARNING_DECAY_DAYS = 30

    # Auto-timeout escalation (minutes)
    DEFAULT_AUTO_TIMEOUT_FIRST = 5
    DEFAULT_AUTO_TIMEOUT_SECOND = 60
    DEFAULT_AUTO_TIMEOUT_THIRD = 1440  # 24 hours

    # Reputation impact per action
    REPUTATION_IMPACT = {
        'warn': -25.0,
        'timeout': -50.0,
        'kick': -75.0,
        'ban': -200.0
    }
