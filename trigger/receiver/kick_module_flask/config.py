"""Configuration for kick_module"""
import os

from dotenv import load_dotenv

load_dotenv()


class Config:
    """KICK module configuration from environment variables."""

    MODULE_NAME = 'kick_module'
    MODULE_VERSION = '1.0.0'
    MODULE_PORT = int(os.getenv('MODULE_PORT', '8007'))
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

    # KICK-specific configuration
    KICK_WEBHOOK_SECRET = os.getenv('KICK_WEBHOOK_SECRET', '')
    KICK_PUSHER_KEY = os.getenv('KICK_PUSHER_KEY', 'eb1d5f283081a78b932c')
    KICK_PUSHER_CLUSTER = os.getenv('KICK_PUSHER_CLUSTER', 'us2')
