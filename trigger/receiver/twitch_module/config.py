"""Configuration for twitch_module"""
import os

from dotenv import load_dotenv

load_dotenv()


class Config:
    """Twitch module configuration from environment variables."""

    MODULE_NAME = 'twitch_module'
    MODULE_VERSION = '2.0.0'
    MODULE_PORT = int(os.getenv('MODULE_PORT', '8002'))
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

    # Twitch API credentials
    TWITCH_CLIENT_ID = os.getenv('TWITCH_CLIENT_ID', '')
    TWITCH_CLIENT_SECRET = os.getenv('TWITCH_CLIENT_SECRET', '')
    TWITCH_ACCESS_TOKEN = os.getenv('TWITCH_ACCESS_TOKEN', '')

    # Hub integration for activity tracking
    HUB_API_URL = os.getenv('HUB_API_URL', 'http://hub-module:8060')
    SERVICE_API_KEY = os.getenv('SERVICE_API_KEY', '')

    # Viewer tracking configuration
    VIEWER_TRACKING_ENABLED = os.getenv('VIEWER_TRACKING_ENABLED', 'true').lower() == 'true'
    VIEWER_POLL_INTERVAL = int(os.getenv('VIEWER_POLL_INTERVAL', '60'))
