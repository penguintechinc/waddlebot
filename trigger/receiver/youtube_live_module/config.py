"""Configuration for youtube_live_module"""
import os

from dotenv import load_dotenv

load_dotenv()


class Config:
    """YouTube Live module configuration from environment variables."""

    MODULE_NAME = 'youtube_live_module'
    MODULE_VERSION = '1.0.0'
    MODULE_PORT = int(os.getenv('MODULE_PORT', '8006'))

    DATABASE_URL = os.getenv(
        'DATABASE_URL',
        'postgresql://waddlebot:password@localhost:5432/waddlebot'
    )
    ROUTER_API_URL = os.getenv(
        'ROUTER_API_URL',
        'http://router-service:8000/api/v1/router'
    )

    # YouTube API Configuration
    YOUTUBE_API_KEY = os.getenv('YOUTUBE_API_KEY', '')
    YOUTUBE_CLIENT_ID = os.getenv('YOUTUBE_CLIENT_ID', '')
    YOUTUBE_CLIENT_SECRET = os.getenv('YOUTUBE_CLIENT_SECRET', '')
    YOUTUBE_API_VERSION = 'v3'

    # Webhook Configuration
    YOUTUBE_WEBHOOK_CALLBACK_URL = os.getenv(
        'YOUTUBE_WEBHOOK_CALLBACK_URL',
        'http://localhost:8006/api/v1/webhook'
    )
    YOUTUBE_PUBSUB_HUB = 'https://pubsubhubbub.appspot.com/subscribe'

    # Chat Polling Configuration
    CHAT_POLL_INTERVAL = int(os.getenv('CHAT_POLL_INTERVAL', '5'))
    CHAT_MAX_RESULTS = int(os.getenv('CHAT_MAX_RESULTS', '200'))

    # OAuth Scopes (read-only for trigger module)
    YOUTUBE_SCOPES = [
        'https://www.googleapis.com/auth/youtube.readonly',
    ]

    # Logging
    LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')
    SECRET_KEY = os.getenv('SECRET_KEY', 'change-me-in-production')
