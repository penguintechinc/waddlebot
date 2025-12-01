"""
Configuration for community_hub_module
The epicenter for WaddleBot communities across all platforms.
"""
import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    # Module identification
    MODULE_NAME = 'community_hub_module'
    MODULE_VERSION = '1.0.0'
    MODULE_PORT = int(os.getenv('MODULE_PORT', '8060'))

    # Database
    DATABASE_URL = os.getenv(
        'DATABASE_URL',
        'postgresql://waddlebot:password@localhost:5432/waddlebot'
    )

    # Core API integration
    ROUTER_API_URL = os.getenv(
        'ROUTER_API_URL',
        'http://router:8000/api/v1/router'
    )

    # Identity service for OAuth
    IDENTITY_API_URL = os.getenv(
        'IDENTITY_API_URL',
        'http://identity-core:8050'
    )

    # Module integration URLs
    INVENTORY_API_URL = os.getenv(
        'INVENTORY_API_URL',
        'http://inventory-interaction:8024'
    )
    REPUTATION_API_URL = os.getenv(
        'REPUTATION_API_URL',
        'http://reputation:8021'
    )
    CALENDAR_API_URL = os.getenv(
        'CALENDAR_API_URL',
        'http://calendar-interaction:8030'
    )
    MEMORIES_API_URL = os.getenv(
        'MEMORIES_API_URL',
        'http://memories-interaction:8031'
    )
    LABELS_API_URL = os.getenv(
        'LABELS_API_URL',
        'http://labels-core:8023'
    )
    SHOUTOUT_API_URL = os.getenv(
        'SHOUTOUT_API_URL',
        'http://shoutout-interaction:8011'
    )

    # Redis configuration
    REDIS_HOST = os.getenv('REDIS_HOST', 'redis')
    REDIS_PORT = int(os.getenv('REDIS_PORT', '6379'))
    REDIS_PASSWORD = os.getenv('REDIS_PASSWORD', '')
    REDIS_DB = int(os.getenv('REDIS_DB', '0'))

    # Security
    SECRET_KEY = os.getenv('SECRET_KEY', 'change-me-in-production')
    JWT_SECRET_KEY = os.getenv('JWT_SECRET_KEY', SECRET_KEY)
    SESSION_TTL = int(os.getenv('SESSION_TTL', '3600'))

    # Domain configuration
    BASE_DOMAIN = os.getenv('BASE_DOMAIN', 'waddlebot.io')
    HUB_SUBDOMAIN = os.getenv('HUB_SUBDOMAIN', 'hub')

    # Blocked subdomain names (reserved for system use)
    BLOCKED_SUBDOMAINS = {
        'www', 'mail', 'smtp', 'imap', 'pop', 'ftp', 'api', 'admin',
        'portal', 'hub', 'app', 'dashboard', 'status', 'docs', 'help',
        'support', 'billing', 'cdn', 'static', 'assets', 'media', 'img',
        'images', 'dev', 'staging', 'test', 'demo', 'beta', 'auth',
        'login', 'oauth', 'sso', 'identity'
    }

    # OAuth configuration (platform colors for UI)
    OAUTH_PLATFORMS = {
        'discord': {'color': '#5865F2', 'name': 'Discord'},
        'twitch': {'color': '#9146FF', 'name': 'Twitch'},
        'slack': {'color': '#4A154B', 'name': 'Slack'},
    }

    # Live updates configuration
    POLLING_INTERVAL_LIVE = int(os.getenv('POLLING_INTERVAL_LIVE', '30'))
    POLLING_INTERVAL_ACTIVITY = int(os.getenv('POLLING_INTERVAL_ACTIVITY', '60'))

    # Pagination defaults
    DEFAULT_PAGE_SIZE = int(os.getenv('DEFAULT_PAGE_SIZE', '20'))
    MAX_PAGE_SIZE = int(os.getenv('MAX_PAGE_SIZE', '100'))

    # Logging
    LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')
